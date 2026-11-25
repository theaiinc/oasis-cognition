import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { StoredPushSubscription } from './mobile-push.types';

const REDIS_KEY = 'oasis:mobile-push:subscriptions';

/** The few hash operations the store needs, so tests can hand it a map. */
export interface HashBackend {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

/** In-process stand-in when Redis isn't reachable (registrations then last until restart). */
export class MemoryHash implements HashBackend {
  private readonly data = new Map<string, Map<string, string>>();
  async hset(key: string, field: string, value: string) { this.map(key).set(field, value); return 1; }
  async hdel(key: string, field: string) { return this.map(key).delete(field) ? 1 : 0; }
  async hgetall(key: string) { return Object.fromEntries(this.map(key)); }
  private map(key: string) {
    let m = this.data.get(key);
    if (!m) { m = new Map(); this.data.set(key, m); }
    return m;
  }
}

/**
 * Web Push registrations, one per (user, device). A phone registers again
 * whenever its subscription changes, which replaces the old one.
 */
@Injectable()
export class PushSubscriptionStore implements OnModuleDestroy {
  private readonly logger = new Logger(PushSubscriptionStore.name);
  private redis: Redis | null = null;
  private readonly memory = new MemoryHash();
  private backend: HashBackend;

  constructor() {
    this.backend = this.memory;
    if (process.env.NODE_ENV === 'test') return;
    try {
      const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: 3,
        retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
        lazyConnect: true,
      });
      this.redis = redis;
      redis.connect()
        .then(() => { this.backend = redis; })
        .catch(() => this.logger.warn('Redis unavailable; push registrations held in memory only'));
    } catch {
      this.logger.warn('Redis init failed; push registrations held in memory only');
    }
  }

  /** For tests. */
  useBackend(backend: HashBackend): this {
    this.backend = backend;
    return this;
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  async save(entry: StoredPushSubscription): Promise<void> {
    await this.backend.hset(REDIS_KEY, field(entry.user_id, entry.device_id), JSON.stringify(entry));
  }

  async remove(userId: string, deviceId: string): Promise<boolean> {
    return Number(await this.backend.hdel(REDIS_KEY, field(userId, deviceId))) > 0;
  }

  /** A user's devices, or every registration when userId is null (single-owner installs). */
  async list(userId: string | null): Promise<StoredPushSubscription[]> {
    const all = await this.backend.hgetall(REDIS_KEY);
    const out: StoredPushSubscription[] = [];
    for (const raw of Object.values(all || {})) {
      try {
        const entry = JSON.parse(raw) as StoredPushSubscription;
        if (userId === null || entry.user_id === userId) out.push(entry);
      } catch { /* skip a corrupt entry */ }
    }
    return out;
  }
}

function field(userId: string, deviceId: string): string {
  return `${userId}\u0000${deviceId}`;
}
