import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Allocates worktrees per chat session and persists the mapping in Redis so
 * concurrent sessions never reuse each other's worktree, and so a gateway
 * restart preserves the session→worktree binding.
 *
 * Layout:
 *   oasis:session→worktree   (hash) sessionId  → worktreeId   (forward)
 *   oasis:worktree→session   (hash) worktreeId → sessionId    (reverse, for collision lookup)
 *
 * Falls back to an in-memory map when Redis is unavailable; concurrency
 * guarantees only hold within a single gateway process in that case, but the
 * collision check still prevents two sessions in the same process from
 * grabbing the same worktree.
 */
@Injectable()
export class SessionWorktreeService {
  private readonly logger = new Logger(SessionWorktreeService.name);
  private redis: Redis | null = null;
  private readonly memSessionToWorktree = new Map<string, string>();
  private readonly memWorktreeToSession = new Map<string, string>();

  private static readonly FORWARD_KEY = 'oasis:session_worktrees';
  private static readonly REVERSE_KEY = 'oasis:worktree_sessions';

  constructor() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect().catch(() => {
        this.logger.warn('Redis unavailable; session→worktree map will not persist across restarts');
      });
    } catch {
      this.logger.warn('Redis init failed; session→worktree map will not persist across restarts');
    }
  }

  private redisReady(): boolean {
    return !!this.redis && (this.redis.status === 'ready' || this.redis.status === 'connecting');
  }

  async get(sessionId: string): Promise<string | undefined> {
    if (!sessionId) return undefined;
    if (this.redisReady()) {
      try {
        const v = await this.redis!.hget(SessionWorktreeService.FORWARD_KEY, sessionId);
        if (v) return v;
      } catch (err) {
        this.logger.warn(`get failed: ${err}`);
      }
    }
    return this.memSessionToWorktree.get(sessionId);
  }

  async ownerOf(worktreeId: string): Promise<string | undefined> {
    if (!worktreeId) return undefined;
    if (this.redisReady()) {
      try {
        const v = await this.redis!.hget(SessionWorktreeService.REVERSE_KEY, worktreeId);
        if (v) return v;
      } catch (err) {
        this.logger.warn(`ownerOf failed: ${err}`);
      }
    }
    return this.memWorktreeToSession.get(worktreeId);
  }

  /**
   * Bind a worktree to a session. Throws if the worktree is already owned by a
   * different session — caller must `release` it first or pick another one.
   *
   * Race safety: uses HSETNX on the reverse map so two concurrent claims can't
   * both succeed. The forward map is only written after the reverse claim wins,
   * keeping the two halves consistent under contention.
   */
  async claim(sessionId: string, worktreeId: string): Promise<void> {
    if (!sessionId || !worktreeId) throw new Error('claim requires sessionId and worktreeId');
    // Release any previous worktree for this session so the reverse map stays consistent.
    const prev = await this.get(sessionId);
    if (prev && prev !== worktreeId) {
      await this.releaseWorktree(prev);
    }
    if (this.redisReady()) {
      try {
        // HSETNX returns 1 if the field was set, 0 if it already existed.
        const won = await this.redis!.hsetnx(SessionWorktreeService.REVERSE_KEY, worktreeId, sessionId);
        if (won === 0) {
          const owner = await this.redis!.hget(SessionWorktreeService.REVERSE_KEY, worktreeId);
          if (owner && owner !== sessionId) {
            throw new Error(`Worktree '${worktreeId}' is already owned by session '${owner}'`);
          }
          // Same owner; idempotent re-claim.
        }
        await this.redis!.hset(SessionWorktreeService.FORWARD_KEY, sessionId, worktreeId);
      } catch (err: any) {
        if (err?.message?.includes('already owned')) throw err;
        this.logger.warn(`claim redis write failed; falling back to memory: ${err}`);
      }
    } else {
      // In-memory race check (single-process only).
      const owner = this.memWorktreeToSession.get(worktreeId);
      if (owner && owner !== sessionId) {
        throw new Error(`Worktree '${worktreeId}' is already owned by session '${owner}'`);
      }
    }
    this.memSessionToWorktree.set(sessionId, worktreeId);
    this.memWorktreeToSession.set(worktreeId, sessionId);
    this.logger.log(`Session ${sessionId} ↔ worktree ${worktreeId}`);
  }

  /** Forget the binding for a session (used after the session's worktree is applied/discarded). */
  async releaseSession(sessionId: string): Promise<void> {
    const wt = await this.get(sessionId);
    if (wt) await this.releaseWorktree(wt);
    if (this.redisReady()) {
      try {
        await this.redis!.hdel(SessionWorktreeService.FORWARD_KEY, sessionId);
      } catch (err) {
        this.logger.warn(`releaseSession redis failed: ${err}`);
      }
    }
    this.memSessionToWorktree.delete(sessionId);
  }

  /** Forget the binding for a worktree (used when the worktree is discarded). */
  async releaseWorktree(worktreeId: string): Promise<void> {
    const owner = await this.ownerOf(worktreeId);
    if (this.redisReady()) {
      try {
        const pipe = this.redis!.multi();
        pipe.hdel(SessionWorktreeService.REVERSE_KEY, worktreeId);
        if (owner) pipe.hdel(SessionWorktreeService.FORWARD_KEY, owner);
        await pipe.exec();
      } catch (err) {
        this.logger.warn(`releaseWorktree redis failed: ${err}`);
      }
    }
    this.memWorktreeToSession.delete(worktreeId);
    if (owner) this.memSessionToWorktree.delete(owner);
  }

  /** Snapshot of the full mapping (debug + UI). */
  async listAll(): Promise<Array<{ session_id: string; worktree_id: string }>> {
    if (this.redisReady()) {
      try {
        const map = await this.redis!.hgetall(SessionWorktreeService.FORWARD_KEY);
        return Object.entries(map).map(([session_id, worktree_id]) => ({ session_id, worktree_id }));
      } catch (err) {
        this.logger.warn(`listAll failed: ${err}`);
      }
    }
    return Array.from(this.memSessionToWorktree.entries()).map(([session_id, worktree_id]) => ({ session_id, worktree_id }));
  }
}
