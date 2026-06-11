import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PricingService } from '../session/pricing.service';
import { JOB_USAGE_KEY } from './coordinator.types';
import type { JobUsage } from './coordinator.types';

/**
 * Tracks cumulative LLM token usage and cost per coordinator job.
 * Mirrors SessionUsageService but keyed by job_id instead of session_id.
 */
const OUTPUT_TOKEN_FUDGE = 0.2;

@Injectable()
export class JobUsageService {
  private readonly logger = new Logger(JobUsageService.name);
  private redis: Redis | null = null;
  private redisReady = false;
  private readonly usageCache = new Map<string, JobUsage>();

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
        .catch(() => this.logger.warn('Redis unavailable; job usage held in memory only'));
    } catch {
      this.logger.warn('Redis init failed; job usage held in memory only');
    }
  }

  async getUsage(jobId: string): Promise<JobUsage> {
    if (this.usageCache.has(jobId)) return this.usageCache.get(jobId)!;
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(JOB_USAGE_KEY, jobId);
        if (v) {
          const parsed = JSON.parse(v) as JobUsage;
          this.usageCache.set(jobId, parsed);
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`getUsage redis: ${err}`);
      }
    }
    const fresh = freshUsage(jobId);
    this.usageCache.set(jobId, fresh);
    return fresh;
  }

  async addTurn(
    jobId: string,
    model: string | null,
    provider: string | null,
    inputTokens: number,
    outputTokens: number | null,
  ): Promise<void> {
    if (!jobId || inputTokens <= 0) return;
    const u = await this.getUsage(jobId);
    u.input_tokens += inputTokens;
    u.output_tokens += Math.max(0, outputTokens ?? Math.round(inputTokens * OUTPUT_TOKEN_FUDGE));
    if (model) u.last_model = model;
    if (provider) u.last_provider = provider;
    this.recomputeUsd(u);
    u.last_updated = new Date().toISOString();
    await this.persistUsage(u);
  }

  /** Aggregate a child agent's terminal usage into the job total. */
  async addChildUsage(
    jobId: string,
    childUsage: { input_tokens?: number; output_tokens?: number; model?: string | null },
  ): Promise<void> {
    if (!jobId) return;
    const u = await this.getUsage(jobId);
    const inputTokens = childUsage.input_tokens ?? 0;
    const outputTokens = childUsage.output_tokens ?? 0;
    u.input_tokens += inputTokens;
    u.output_tokens += outputTokens;
    const childModel = childUsage.model || u.last_model;
    if (childUsage.model) u.last_model = childUsage.model;
    // Compute cost for this child's tokens using the child's model,
    // then add to cumulative total (avoids cross-model contamination)
    if (childModel && (inputTokens > 0 || outputTokens > 0)) {
      const est = this.pricing.estimateUsd(inputTokens, outputTokens, childModel, u.last_provider);
      u.cost_usd += est.usd;
      if (est.known) u.cost_known = true;
    }
    u.last_updated = new Date().toISOString();
    await this.persistUsage(u);
  }

  async resetUsage(jobId: string): Promise<void> {
    this.usageCache.delete(jobId);
    if (this.redis && this.redisReady) {
      try { await this.redis.hdel(JOB_USAGE_KEY, jobId); }
      catch (err) { this.logger.warn(`resetUsage redis: ${err}`); }
    }
  }

  private recomputeUsd(u: JobUsage): void {
    if (!u.last_model) { u.cost_usd = 0; u.cost_known = false; return; }
    const est = this.pricing.estimateUsd(u.input_tokens, u.output_tokens, u.last_model, u.last_provider);
    u.cost_usd = est.usd;
    u.cost_known = est.known;
  }

  private async persistUsage(u: JobUsage): Promise<void> {
    this.usageCache.set(u.job_id, u);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(JOB_USAGE_KEY, u.job_id, JSON.stringify(u)); }
      catch (err) { this.logger.warn(`persistUsage redis: ${err}`); }
    }
  }

  /** Predict USD for a given (task, model) pair before spawning. */
  estimateCost(task: { goal: string; est_input_tokens?: number; est_output_tokens?: number }, model: string | null, provider?: string | null): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number } {
    const goalLen = (task.goal?.length ?? 0);
    const lowInput = task.est_input_tokens ?? Math.round(goalLen * 0.5);
    const highInput = task.est_input_tokens ?? Math.round(goalLen * 2);
    const lowOutput = task.est_output_tokens ?? Math.round(lowInput * 0.3);
    const highOutput = task.est_output_tokens ?? Math.round(highInput * 0.6);
    const lowEst = this.pricing.estimateUsd(lowInput, lowOutput, model, provider);
    const highEst = this.pricing.estimateUsd(highInput, highOutput, model, provider);
    return {
      usd_low: lowEst.usd,
      usd_high: highEst.usd,
      tokens_low: lowInput + lowOutput,
      tokens_high: highInput + highOutput,
    };
  }
}

function freshUsage(jobId: string): JobUsage {
  return {
    job_id: jobId,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_known: false,
    last_model: null,
    last_provider: null,
    last_updated: new Date().toISOString(),
  };
}
