import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { PricingService } from './pricing.service';
import type { UsdEstimate } from './pricing';

/**
 * Tracks cumulative LLM token usage per session and enforces optional
 * per-session budget caps. Two storage hashes in Redis:
 *
 *   oasis:session_usage   sessionId -> JSON SessionUsage
 *   oasis:session_budget  sessionId -> JSON BudgetConfig
 *
 * Both are read-through from Redis with an in-process cache so the hot
 * path during interactions doesn't round-trip Redis on every token batch.
 *
 * Output tokens are estimated as a 20% fudge over input — agent loops are
 * dominated by repeated context (input), and tracking output exactly would
 * require touching every LLM call site. The estimate is intentionally a
 * slight overcount so the cap fires conservatively.
 */

export type BudgetMode = 'unlimited' | 'tokens' | 'usd';

export interface BudgetConfig {
  mode: BudgetMode;
  /** Token cap if mode='tokens', USD cap if mode='usd'. Ignored if mode='unlimited'. */
  limit: number;
  /** Display amber warning at this fraction of the cap (default 0.8). */
  warn_at_pct: number;
}

export interface SessionUsage {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  /** USD estimate based on the most recent model used. May be 0 if model is unknown. */
  usd_estimate: number;
  usd_known: boolean;
  /** When this row's pricing rates were last verified (passes through to UI). */
  pricing_updated_at: string | null;
  /** Most recently seen model name — used for USD recompute on each addition. */
  last_model: string | null;
  /** Most recently seen provider name — used for USD recompute. */
  last_provider: string | null;
  last_updated: string;
}

export interface BudgetCheck {
  /** True when the session has hit or exceeded its cap and any further LLM call should be refused. */
  over: boolean;
  /** True when usage is at warn_at_pct or above. */
  warn: boolean;
  /** Fraction of cap consumed (0..1+). 0 when budget mode is 'unlimited'. */
  pct: number;
  usage: SessionUsage;
  budget: BudgetConfig;
  /** Human-readable explanation when `over` is true (used as the chat refusal message). */
  reason: string | null;
}

const USAGE_KEY = 'oasis:session_usage';
const BUDGET_KEY = 'oasis:session_budget';
const OUTPUT_TOKEN_FUDGE = 0.2; // see service docstring

const DEFAULT_BUDGET: BudgetConfig = {
  mode: 'unlimited',
  limit: 0,
  warn_at_pct: 0.8,
};

@Injectable()
export class SessionUsageService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionUsageService.name);
  private redis: Redis | null = null;
  private redisReady = false;
  private readonly usageCache = new Map<string, SessionUsage>();
  private readonly budgetCache = new Map<string, BudgetConfig>();

  constructor(
    private readonly pricing: PricingService,
  ) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => { this.redisReady = true; })
        .catch(() => this.logger.warn('Redis unavailable; session usage held in memory only'));
    } catch {
      this.logger.warn('Redis init failed; session usage held in memory only');
    }
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  // ── Usage ──────────────────────────────────────────────────────────

  async getUsage(sessionId: string): Promise<SessionUsage> {
    if (this.usageCache.has(sessionId)) return this.usageCache.get(sessionId)!;
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(USAGE_KEY, sessionId);
        if (v) {
          const parsed = JSON.parse(v) as SessionUsage;
          this.usageCache.set(sessionId, parsed);
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`getUsage redis: ${err}`);
      }
    }
    const fresh = freshUsage(sessionId);
    this.usageCache.set(sessionId, fresh);
    return fresh;
  }

  /**
   * Add a turn's worth of token usage. Pass `outputTokens=null` if you only
   * have an input count; the service will fill in an output estimate as
   * `OUTPUT_TOKEN_FUDGE * inputTokens` so caps still apply roughly correctly.
   */
  async addTurn(
    sessionId: string,
    model: string | null,
    provider: string | null,
    inputTokens: number,
    outputTokens: number | null,
  ): Promise<void> {
    if (!sessionId || inputTokens <= 0) return;
    const u = await this.getUsage(sessionId);
    u.input_tokens += inputTokens;
    u.output_tokens += Math.max(0, outputTokens ?? Math.round(inputTokens * OUTPUT_TOKEN_FUDGE));
    if (model) u.last_model = model;
    if (provider) u.last_provider = provider;
    this.recomputeUsd(u);
    u.last_updated = new Date().toISOString();
    await this.persistUsage(u);
  }

  async resetUsage(sessionId: string): Promise<void> {
    this.usageCache.delete(sessionId);
    if (this.redis && this.redisReady) {
      try { await this.redis.hdel(USAGE_KEY, sessionId); }
      catch (err) { this.logger.warn(`resetUsage redis: ${err}`); }
    }
  }

  private recomputeUsd(u: SessionUsage): void {
    const est: UsdEstimate = this.pricing.estimateUsd(u.input_tokens, u.output_tokens, u.last_model, u.last_provider);
    u.usd_estimate = est.usd;
    u.usd_known = est.known;
    u.pricing_updated_at = est.updated_at;
  }

  private async persistUsage(u: SessionUsage): Promise<void> {
    this.usageCache.set(u.session_id, u);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(USAGE_KEY, u.session_id, JSON.stringify(u)); }
      catch (err) { this.logger.warn(`persistUsage redis: ${err}`); }
    }
  }

  // ── Budget config ──────────────────────────────────────────────────

  async getBudget(sessionId: string): Promise<BudgetConfig> {
    if (!sessionId) return { ...DEFAULT_BUDGET };
    if (this.budgetCache.has(sessionId)) return this.budgetCache.get(sessionId)!;
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(BUDGET_KEY, sessionId);
        if (v) {
          const parsed = { ...DEFAULT_BUDGET, ...JSON.parse(v) } as BudgetConfig;
          this.budgetCache.set(sessionId, parsed);
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`getBudget redis: ${err}`);
      }
    }
    return { ...DEFAULT_BUDGET };
  }

  async setBudget(sessionId: string, patch: Partial<BudgetConfig>): Promise<BudgetConfig> {
    const prev = await this.getBudget(sessionId);
    const next: BudgetConfig = {
      mode: patch.mode === 'tokens' || patch.mode === 'usd' || patch.mode === 'unlimited' ? patch.mode : prev.mode,
      limit: typeof patch.limit === 'number' && Number.isFinite(patch.limit) && patch.limit >= 0 ? patch.limit : prev.limit,
      warn_at_pct: typeof patch.warn_at_pct === 'number' && patch.warn_at_pct > 0 && patch.warn_at_pct <= 1 ? patch.warn_at_pct : prev.warn_at_pct,
    };
    this.budgetCache.set(sessionId, next);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(BUDGET_KEY, sessionId, JSON.stringify(next)); }
      catch (err) { this.logger.warn(`setBudget redis: ${err}`); }
    }
    return next;
  }

  // ── Enforcement ────────────────────────────────────────────────────

  /**
   * Check the session against its budget. Call before starting any new LLM
   * work; if `over` is true, the caller must refuse the request and surface
   * `reason` to the user (typically rendered as a chat system message with
   * a "raise cap" affordance).
   */
  async checkBudget(sessionId: string): Promise<BudgetCheck> {
    const usage = await this.getUsage(sessionId);
    const budget = await this.getBudget(sessionId);
    if (budget.mode === 'unlimited' || budget.limit <= 0) {
      return { over: false, warn: false, pct: 0, usage, budget, reason: null };
    }
    const consumed = budget.mode === 'tokens'
      ? usage.input_tokens + usage.output_tokens
      : usage.usd_estimate;
    const pct = budget.limit > 0 ? consumed / budget.limit : 0;
    const over = pct >= 1.0;
    const warn = pct >= budget.warn_at_pct && !over;
    let reason: string | null = null;
    if (over) {
      const consumedFmt = budget.mode === 'tokens'
        ? `${Math.round(consumed).toLocaleString()} tokens`
        : `$${consumed.toFixed(4)}`;
      const limitFmt = budget.mode === 'tokens'
        ? `${budget.limit.toLocaleString()} tokens`
        : `$${budget.limit.toFixed(2)}`;
      reason = `This session has hit its budget cap (${consumedFmt} of ${limitFmt}). Raise the cap in Settings, or start a new chat.`;
    }
    return { over, warn, pct, usage, budget, reason };
  }
}

function freshUsage(sessionId: string): SessionUsage {
  return {
    session_id: sessionId,
    input_tokens: 0,
    output_tokens: 0,
    usd_estimate: 0,
    usd_known: false,
    pricing_updated_at: null,
    last_model: null,
    last_provider: null,
    last_updated: new Date().toISOString(),
  };
}
