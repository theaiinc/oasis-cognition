import Redis from 'ioredis';
import { JOB_BUDGET_KEY } from './types';
import type { JobBudget } from './types';

const DEFAULT_BUDGET: JobBudget = {
  max_usd: 5.0,
  max_tokens: 0,
  auto_approved: false,
  user_adjusted_limit: null,
  safety_factor: 1.2,
};

export class JobBudgetService {
  private redis: Redis | null = null;
  private redisReady = false;
  private readonly budgetCache = new Map<string, JobBudget>();

  constructor() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => { this.redisReady = true; })
        .catch(() => console.warn('Redis unavailable; job budget held in memory only'));
    } catch {
      console.warn('Redis init failed; job budget held in memory only');
    }
  }

  async getBudget(jobId: string): Promise<JobBudget> {
    if (!jobId) return { ...DEFAULT_BUDGET };
    if (this.budgetCache.has(jobId)) return this.budgetCache.get(jobId)!;
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(JOB_BUDGET_KEY, jobId);
        if (v) {
          const parsed = { ...DEFAULT_BUDGET, ...JSON.parse(v) } as JobBudget;
          this.budgetCache.set(jobId, parsed);
          return parsed;
        }
      } catch (err: any) {
        console.warn(`getBudget redis: ${err.message}`);
      }
    }
    return { ...DEFAULT_BUDGET };
  }

  async setBudget(jobId: string, patch: Partial<JobBudget>): Promise<JobBudget> {
    const prev = await this.getBudget(jobId);
    const next: JobBudget = {
      max_usd: typeof patch.max_usd === 'number' && patch.max_usd >= 0 ? patch.max_usd : prev.max_usd,
      max_tokens: typeof patch.max_tokens === 'number' && patch.max_tokens >= 0 ? patch.max_tokens : prev.max_tokens,
      auto_approved: typeof patch.auto_approved === 'boolean' ? patch.auto_approved : prev.auto_approved,
      user_adjusted_limit: patch.user_adjusted_limit !== undefined ? patch.user_adjusted_limit : prev.user_adjusted_limit,
      safety_factor: typeof patch.safety_factor === 'number' && patch.safety_factor >= 1.0 ? patch.safety_factor : prev.safety_factor,
    };
    this.budgetCache.set(jobId, next);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(JOB_BUDGET_KEY, jobId, JSON.stringify(next)); }
      catch (err: any) { console.warn(`setBudget redis: ${err.message}`); }
    }
    return next;
  }

  async checkBudget(jobId: string, currentUsd: number): Promise<{ over: boolean; pct: number; reason: string | null }> {
    const budget = await this.getBudget(jobId);
    const limit = budget.user_adjusted_limit ?? budget.max_usd;
    if (limit <= 0) return { over: false, pct: 0, reason: null };
    const pct = currentUsd / limit;
    const over = pct >= 1.0 || (budget.max_tokens > 0 && pct >= 1.0);
    const reason = over
      ? `Job budget exceeded ($${currentUsd.toFixed(4)} of $${limit.toFixed(2)}). Raise the cap or cancel the job.`
      : null;
    return { over, pct, reason };
  }

  async resetBudget(jobId: string): Promise<void> {
    this.budgetCache.delete(jobId);
    if (this.redis && this.redisReady) {
      try { await this.redis.hdel(JOB_BUDGET_KEY, jobId); }
      catch (err: any) { console.warn(`resetBudget redis: ${err.message}`); }
    }
  }
}
