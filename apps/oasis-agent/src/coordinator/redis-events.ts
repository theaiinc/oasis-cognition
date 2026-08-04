import { EventEmitter } from 'events';
import Redis from 'ioredis';
import type { EventPayload } from './types';

export class RedisEventService {
  private readonly emitter = new EventEmitter();
  private redis: Redis | null = null;
  private redisReady = false;

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
        .catch(() => console.warn('Redis unavailable; events use in-memory only'));
    } catch {
      console.warn('Redis init failed; events use in-memory only');
    }
  }

  async publish(channel: string, sessionId: string, data: Record<string, unknown>): Promise<void> {
    const payload: EventPayload = { channel, session_id: sessionId, data };
    const json = JSON.stringify(payload);

    // Local listeners
    this.emitter.emit(channel, payload);

    // Redis pub/sub
    if (this.redis && this.redisReady) {
      try {
        await this.redis.publish(channel, json);
      } catch (err: any) {
        console.warn(`Redis publish(${channel}) failed: ${err.message}`);
      }
    }
  }

  subscribe(channel: string, handler: (payload: EventPayload) => void): () => void {
    this.emitter.on(channel, handler);
    return () => { this.emitter.off(channel, handler); };
  }
}
