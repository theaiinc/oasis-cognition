import Redis from 'ioredis';
import { PricingService } from './pricing';
import { JOB_USAGE_KEY } from './types';
import type { JobUsage } from './types';

const OUTPUT_TOKEN_FUDGE = 0.2;

export class JobUsageService {
  private redis: Redis | null = null;
  private redisReady = false;
  private readonly usageCache = new Map<string, JobUsage>();
  private readonly pricing: PricingService;

  constructor() {
    this.pricing = new PricingService();
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => { this.redisReady = true; })
        .catch(() => console.warn('Redis unavailable; job usage held in memory only'));
    } catch {
      console.warn('Redis init failed; job usage held in memory only');
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
      } catch (err: any) {
        console.warn(`getUsage redis: ${err.message}`);
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
      catch (err: any) { console.warn(`resetUsage redis: ${err.message}`); }
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
      catch (err: any) { console.warn(`persistUsage redis: ${err.message}`); }
    }
  }

  estimateCost(
    task: { goal: string; est_input_tokens?: number; est_output_tokens?: number },
    model: string | null,
    provider?: string | null,
  ): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number } {
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
