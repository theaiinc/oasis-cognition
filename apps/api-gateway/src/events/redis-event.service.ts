import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

const STREAM_KEY = 'oasis:events';
const MAX_BACKLOG_EVENTS = 200;

export interface OasisEvent {
  event_id: string;
  event_type: string;
  session_id: string;
  trace_id: string;
  timestamp: string;
  payload: Record<string, any>;
}

@Injectable()
export class RedisEventService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisEventService.name);
  private redis: Redis | null = null;
  private connected = false;
  private reader: Redis | null = null;
  /** After ping once; reset if reader is torn down. */
  private streamReaderVerified = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.warn('Redis unavailable, events will be logged only');
            return null;
          }
          return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
      });
      this.redis.connect().then(() => {
        this.connected = true;
        this.logger.log(`Connected to Redis at ${redisUrl}`);
        // Blocking XREAD runs on a dedicated duplicate; created lazily in ensureStreamReaderReady()
        // so it cannot race behind ensureRedisReady() and starve the event loop via SSE busy-wait.
      }).catch(() => {
        this.logger.warn('Redis not available, events will be logged only');
      });
    } catch {
      this.logger.warn('Redis not available, events will be logged only');
    }
  }

  async publish(eventType: string, sessionId: string, payload: Record<string, any>): Promise<void> {
    const event: OasisEvent = {
      event_id: uuidv4(),
      event_type: eventType,
      session_id: sessionId,
      trace_id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload,
    };

    this.logger.debug(`Event: ${eventType} (session=${sessionId})`);

    const r = this.redis;
    if (r && (await this.ensureRedisReady())) {
      try {
        await r.xadd(
          STREAM_KEY,
          '*',
          'event_id', event.event_id,
          'event_type', event.event_type,
          'session_id', event.session_id,
          'trace_id', event.trace_id,
          'timestamp', event.timestamp,
          'payload', JSON.stringify(event.payload),
        );
      } catch (err) {
        this.logger.warn(`Failed to publish event to Redis: ${err}`);
      }
    }
  }

  isReady(): boolean {
    return Boolean(this.redis && this.connected && this.reader);
  }

  async getBacklog(sessionId: string, limit: number = 50): Promise<OasisEvent[]> {
    const r = this.redis;
    if (!r || !(await this.ensureRedisReady())) return [];
    // Fetch more than needed since we filter by session_id after parsing.
    const fetchCount = Math.min(Math.max(limit, 1) * 4, MAX_BACKLOG_EVENTS * 2);
    try {
      const rows = await r.xrevrange(STREAM_KEY, '+', '-', 'COUNT', fetchCount);
      const events = rows
        .map(([_id, fields]) => this._parseStreamFields(fields))
        .filter((e): e is OasisEvent => e !== null && e.session_id === sessionId)
        .reverse();
      // Return at most `limit` events.
      return events.slice(-Math.min(Math.max(limit, 1), MAX_BACKLOG_EVENTS));
    } catch (err) {
      this.logger.warn(`Failed to read backlog from Redis: ${err}`);
      return [];
    }
  }

  /**
   * Dedicated client for XREAD BLOCK. Lazily created so it always follows a ready main connection
   * (avoids timeline SSE calling readNextBatch before constructor duplicate finished).
   * maxRetriesPerRequest: null is required for blocking commands in ioredis.
   */
  private async ensureStreamReaderReady(): Promise<boolean> {
    if (!(await this.ensureRedisReady())) return false;
    const base = this.redis;
    if (!base) return false;
    try {
      if (!this.reader) {
        this.reader = base.duplicate({
          maxRetriesPerRequest: null,
          lazyConnect: true,
          retryStrategy: (times) => {
            if (times > 3) return null;
            return Math.min(times * 200, 2000);
          },
        });
      }
      await this.waitForClientReady(this.reader, 'Redis stream reader');
      if (!this.streamReaderVerified) {
        await this.reader.ping();
        this.streamReaderVerified = true;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Redis stream reader not ready: ${err}`);
      try {
        await this.reader?.quit();
      } catch {
        /* ignore */
      }
      this.reader = null;
      this.streamReaderVerified = false;
      return false;
    }
  }

  async readNextBatch(lastId: string): Promise<Array<{ id: string; event: OasisEvent }> > {
    if (!(await this.ensureStreamReaderReady())) {
      // Timeline SSE loop must never tight-spin when Redis/reader is unavailable.
      await new Promise((r) => setTimeout(r, 300));
      return [];
    }
    try {
      // BLOCK for up to 10s so SSE isn't a busy loop.
      // ioredis typings require COUNT to appear before BLOCK.
      const res = await this.reader!.xread('COUNT', 50, 'BLOCK', 10000, 'STREAMS', STREAM_KEY, lastId);
      if (!res || res.length === 0) return [];
      const [_stream, entries] = res[0];
      return (entries || []).map(([id, fields]: [string, string[]]) => {
        const parsed = this._parseStreamFields(fields);
        return { id, event: parsed as OasisEvent };
      }).filter((x) => Boolean(x.event));
    } catch (err) {
      this.logger.warn(`Failed to XREAD from Redis: ${err}`);
      return [];
    }
  }

  private _parseStreamFields(fields: string[]): OasisEvent | null {
    // fields = [k1, v1, k2, v2, ...]
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    try {
      return {
        event_id: obj.event_id,
        event_type: obj.event_type,
        session_id: obj.session_id,
        trace_id: obj.trace_id,
        timestamp: obj.timestamp,
        payload: obj.payload ? JSON.parse(obj.payload) : {},
      };
    } catch {
      return null;
    }
  }

  // ── Conversation history (per session) ─────────────────────────────

  private chatKey(sessionId: string): string {
    return `oasis:chat:${sessionId}`;
  }

  private sessionsKey(): string {
    return 'oasis:sessions';
  }

  /**
   * ioredis rejects `connect()` if a connect is already in flight (e.g. constructor started `connect()`
   * while `ensureRedisReady()` also calls it). Wait until `ready` instead of treating that as failure.
   */
  private async waitForClientReady(client: Redis, label: string): Promise<void> {
    // ioredis sets status to 'ready' when connected; typings omit it in some versions.
    const st = client.status as string;
    if (st === 'ready') return;
    try {
      await client.connect();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already connecting|already connected/i.test(msg)) throw err;
    }
    if ((client.status as string) === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const timeoutMs = 30_000;
      const t = setTimeout(() => {
        cleanup();
        reject(new Error(`${label}: Redis ready timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(t);
        client.removeListener('ready', onReady);
        client.removeListener('error', onErr);
        client.removeListener('end', onEnd);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error(`${label}: connection ended before ready`));
      };
      client.once('ready', onReady);
      client.once('error', onErr);
      client.once('end', onEnd);
    });
  }

  /**
   * Ensure Redis is connected before chat list ops.
   * Without this, early requests run while `this.connected` is still false (connect() in flight),
   * so pushMessage no-ops and getRecentMessages returns [] — LLM requests see no chat_history.
   */
  private async ensureRedisReady(): Promise<boolean> {
    const r = this.redis;
    if (!r) return false;
    try {
      await this.waitForClientReady(r, 'Redis');
      // First successful session: verify with ping. Afterwards skip ping (hot path for publish/chat).
      if (!this.connected) {
        await r.ping();
      }
      this.connected = true;
      return true;
    } catch (err) {
      this.logger.warn(`Redis ensureRedisReady failed: ${err}`);
      this.connected = false;
      return false;
    }
  }

  /** Append a message to the conversation history for this session. */
  async pushMessage(sessionId: string, role: 'user' | 'assistant', text: string): Promise<void> {
    const r = this.redis;
    if (!r || !(await this.ensureRedisReady())) return;
    try {
      const entry = JSON.stringify({ role, content: text, timestamp: new Date().toISOString() });
      await r.rpush(this.chatKey(sessionId), entry);
      // Keep conversation history bounded (last 100 messages)
      await r.ltrim(this.chatKey(sessionId), -100, -1);
      // Track this session in the sessions set with last-active timestamp
      await r.hset(this.sessionsKey(), sessionId, new Date().toISOString());
    } catch (err) {
      this.logger.warn(`Failed to push chat message: ${err}`);
    }
  }

  /** Get full conversation history for a session. */
  async getHistory(sessionId: string): Promise<Array<{ role: string; content: string; timestamp: string }>> {
    const r = this.redis;
    if (!r || !(await this.ensureRedisReady())) return [];
    try {
      const raw = await r.lrange(this.chatKey(sessionId), 0, -1);
      return raw.map(r => JSON.parse(r));
    } catch (err) {
      this.logger.warn(`Failed to get chat history: ${err}`);
      return [];
    }
  }

  /** Get recent N messages for LLM context (returns role/content pairs). */
  async getRecentMessages(sessionId: string, limit: number = 20): Promise<Array<{ role: string; content: string }>> {
    const r = this.redis;
    if (!r || !(await this.ensureRedisReady())) return [];
    try {
      const raw = await r.lrange(this.chatKey(sessionId), -limit, -1);
      return raw.map(r => {
        const parsed = JSON.parse(r);
        return { role: parsed.role, content: parsed.content };
      });
    } catch (err) {
      this.logger.warn(`Failed to get recent messages: ${err}`);
      return [];
    }
  }

  /** List all sessions with their last-active time. */
  async listSessions(): Promise<Array<{ session_id: string; last_active: string; preview?: string }>> {
    const r = this.redis;
    if (!r || !(await this.ensureRedisReady())) return [];
    try {
      const sessions = await r.hgetall(this.sessionsKey());
      const results: Array<{ session_id: string; last_active: string; preview?: string }> = [];
      for (const [sid, lastActive] of Object.entries(sessions)) {
        // Get first user message as preview
        const first = await r.lindex(this.chatKey(sid), 0);
        let preview = '';
        if (first) {
          try {
            const parsed = JSON.parse(first);
            preview = parsed.content?.slice(0, 80) || '';
          } catch { /* skip */ }
        }
        results.push({ session_id: sid, last_active: lastActive, preview });
      }
      // Sort by last_active desc
      results.sort((a, b) => b.last_active.localeCompare(a.last_active));
      return results;
    } catch (err) {
      this.logger.warn(`Failed to list sessions: ${err}`);
      return [];
    }
  }

  /** Delete a session's chat history. */
  async deleteSession(sessionId: string): Promise<void> {
    const r = this.redis;
    if (!r || !(await this.ensureRedisReady())) return;
    try {
      await r.del(this.chatKey(sessionId));
      await r.hdel(this.sessionsKey(), sessionId);
    } catch (err) {
      this.logger.warn(`Failed to delete session: ${err}`);
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
    if (this.reader) {
      await this.reader.quit();
    }
  }
}
