/**
 * Redis-backed persistence for workflows, triggers, and runs.
 *
 * Key layout (all JSON-string values unless noted):
 *   wf:workflows                    SET of workflow_id
 *   wf:workflow:<wid>               JSON  Workflow doc
 *   wf:triggers:by-workflow:<wid>   SET of trigger_id
 *   wf:trigger:<tid>                JSON  Trigger doc
 *   wf:triggers:all                 SET of trigger_id  (for quick "all enabled" scan)
 *   wf:runs:by-workflow:<wid>       ZSET  run_id scored by created_at (ms since epoch)
 *   wf:run:<rid>                    JSON  Run doc            (expires, see retention below)
 *   wf:stream:<rid>                 STREAM  per-run event stream (for SSE tail; expires with the run)
 *
 * Run retention: a run and its stream expire OASIS_WORKFLOW_RUN_TTL_DAYS after their last
 * write (default 30, 0 = keep), and each workflow keeps its newest OASIS_WORKFLOW_MAX_RUNS
 * runs (default 200). Pruning a run deletes its doc and stream, not only its index entry.
 *
 * If Redis is unavailable the store transparently falls back to an in-memory
 * map so the rest of the app keeps working; persistence is just lost across
 * gateway restarts (same degraded behaviour as RedisEventService).
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { Trigger, Workflow, WorkflowRun } from '../workflows.types';

const STREAM_MAX_LEN = 500;

/** Seconds a run is kept after its last write; 0 = no expiry. */
export function runTtlSeconds(): number {
  const raw = process.env.OASIS_WORKFLOW_RUN_TTL_DAYS;
  const days = raw === undefined || raw.trim() === '' ? 30 : Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.round(days * 86_400) : 0;
}

/** Newest runs kept per workflow. */
export function maxRunsPerWorkflow(): number {
  const n = Math.floor(Number(process.env.OASIS_WORKFLOW_MAX_RUNS || 200));
  return Number.isFinite(n) && n >= 1 ? n : 200;
}

export interface RunSweepResult {
  workflow_id: string;
  removed: number;
  kept: number;
}

@Injectable()
export class WorkflowStore implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowStore.name);
  private redis: Redis | null = null;
  private mem = {
    workflows: new Map<string, Workflow>(),
    triggers: new Map<string, Trigger>(),
    runs: new Map<string, WorkflowRun>(),
  };

  constructor() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => this.logger.log(`Redis connected (workflow store) → ${url}`))
        .catch(err => {
          this.logger.warn(`Redis unavailable (workflow store): ${err.message}; using in-memory fallback`);
          this.redis = null;
        });
      this.redis.on('error', (err) => {
        this.logger.debug(`Redis error (ignored; fallback active): ${err.message}`);
      });
    } catch (err: any) {
      this.logger.warn(`Redis init failed: ${err.message}; in-memory only`);
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    try { await this.redis?.quit(); } catch { /* noop */ }
  }

  private get r(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  /* ── Workflows ──────────────────────────────────────────────────── */

  async saveWorkflow(w: Workflow): Promise<void> {
    this.mem.workflows.set(w.workflow_id, w);
    const r = this.r;
    if (!r) return;
    await r.multi()
      .set(`wf:workflow:${w.workflow_id}`, JSON.stringify(w))
      .sadd('wf:workflows', w.workflow_id)
      .exec();
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    const r = this.r;
    if (r) {
      const raw = await r.get(`wf:workflow:${id}`);
      if (raw) return JSON.parse(raw) as Workflow;
    }
    return this.mem.workflows.get(id) ?? null;
  }

  async listWorkflows(): Promise<Workflow[]> {
    const r = this.r;
    if (r) {
      const ids = await r.smembers('wf:workflows');
      if (ids.length === 0) return [];
      const raws = await r.mget(ids.map(id => `wf:workflow:${id}`));
      return raws.filter((x): x is string => !!x).map(x => JSON.parse(x) as Workflow);
    }
    return [...this.mem.workflows.values()];
  }

  async deleteWorkflow(id: string): Promise<void> {
    this.mem.workflows.delete(id);
    const r = this.r;
    if (!r) return;
    await r.multi()
      .del(`wf:workflow:${id}`)
      .srem('wf:workflows', id)
      .exec();
  }

  async deleteRunsForWorkflow(workflowId: string): Promise<void> {
    for (const [runId, run] of this.mem.runs) {
      if (run.workflow_id === workflowId) this.mem.runs.delete(runId);
    }
    const r = this.r;
    if (!r) return;
    const runIds = await r.zrange(`wf:runs:by-workflow:${workflowId}`, 0, -1);
    const tx = r.multi().del(`wf:runs:by-workflow:${workflowId}`);
    for (const runId of runIds) {
      tx.del(`wf:run:${runId}`, `wf:stream:${runId}`);
    }
    await tx.exec();
  }

  /* ── Triggers ──────────────────────────────────────────────────── */

  async saveTrigger(t: Trigger): Promise<void> {
    this.mem.triggers.set(t.trigger_id, t);
    const r = this.r;
    if (!r) return;
    await r.multi()
      .set(`wf:trigger:${t.trigger_id}`, JSON.stringify(t))
      .sadd('wf:triggers:all', t.trigger_id)
      .sadd(`wf:triggers:by-workflow:${t.workflow_id}`, t.trigger_id)
      .exec();
  }

  async getTrigger(id: string): Promise<Trigger | null> {
    const r = this.r;
    if (r) {
      const raw = await r.get(`wf:trigger:${id}`);
      if (raw) return JSON.parse(raw) as Trigger;
    }
    return this.mem.triggers.get(id) ?? null;
  }

  async listTriggers(workflowId?: string): Promise<Trigger[]> {
    const r = this.r;
    if (r) {
      const set = workflowId ? `wf:triggers:by-workflow:${workflowId}` : 'wf:triggers:all';
      const ids = await r.smembers(set);
      if (ids.length === 0) return [];
      const raws = await r.mget(ids.map(id => `wf:trigger:${id}`));
      return raws.filter((x): x is string => !!x).map(x => JSON.parse(x) as Trigger);
    }
    const all = [...this.mem.triggers.values()];
    return workflowId ? all.filter(t => t.workflow_id === workflowId) : all;
  }

  async deleteTrigger(id: string): Promise<void> {
    const existing = await this.getTrigger(id);
    this.mem.triggers.delete(id);
    const r = this.r;
    if (!r || !existing) return;
    await r.multi()
      .del(`wf:trigger:${id}`)
      .srem('wf:triggers:all', id)
      .srem(`wf:triggers:by-workflow:${existing.workflow_id}`, id)
      .exec();
  }

  /* ── Runs ──────────────────────────────────────────────────────── */

  async saveRun(run: WorkflowRun): Promise<void> {
    const isNew = !this.mem.runs.has(run.run_id);
    this.mem.runs.set(run.run_id, run);
    const r = this.r;
    if (!r) {
      if (isNew) this.pruneMemRuns(run.workflow_id);
      return;
    }
    const score = Date.parse(run.created_at) || Date.now();
    const ttl = runTtlSeconds();
    const tx = r.multi();
    if (ttl > 0) {
      tx.set(`wf:run:${run.run_id}`, JSON.stringify(run), 'EX', ttl);
      tx.expire(`wf:stream:${run.run_id}`, ttl);
    } else {
      tx.set(`wf:run:${run.run_id}`, JSON.stringify(run));
    }
    tx.zadd(`wf:runs:by-workflow:${run.workflow_id}`, score, run.run_id);
    await tx.exec();
    if (isNew) await this.sweepRuns(run.workflow_id);
  }

  /**
   * Drop a workflow's runs past retention: older than the TTL, beyond the newest
   * maxRunsPerWorkflow(), or whose doc already expired. Deletes each pruned run's doc and
   * stream along with its index entry (trimming only the index used to leave both behind).
   */
  async sweepRuns(workflowId: string): Promise<RunSweepResult> {
    const r = this.r;
    if (!r) {
      const removed = this.pruneMemRuns(workflowId);
      const kept = [...this.mem.runs.values()].filter(x => x.workflow_id === workflowId).length;
      return { workflow_id: workflowId, removed, kept };
    }
    const index = `wf:runs:by-workflow:${workflowId}`;
    const drop = new Set<string>();
    const ttl = runTtlSeconds();
    if (ttl > 0) {
      for (const id of await r.zrangebyscore(index, '-inf', Date.now() - ttl * 1000)) drop.add(id);
    }
    for (const id of await r.zrange(index, 0, -1 - maxRunsPerWorkflow())) drop.add(id);
    const rest = (await r.zrange(index, 0, -1)).filter(id => !drop.has(id));
    let kept = rest.length;
    if (rest.length) {
      const exists = await r.pipeline(rest.map(id => ['exists', `wf:run:${id}`])).exec();
      rest.forEach((id, i) => {
        if (exists?.[i]?.[1] === 0) { drop.add(id); kept -= 1; }
      });
    }
    if (drop.size) {
      const ids = [...drop];
      const tx = r.multi().zrem(index, ...ids);
      for (const id of ids) {
        tx.del(`wf:run:${id}`, `wf:stream:${id}`);
        this.mem.runs.delete(id);
      }
      await tx.exec();
    }
    return { workflow_id: workflowId, removed: drop.size, kept };
  }

  /** Every workflow that has a run index, including ones already deleted. */
  async workflowIdsWithRuns(): Promise<string[]> {
    const r = this.r;
    if (!r) return [...new Set([...this.mem.runs.values()].map(x => x.workflow_id))];
    const ids = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', 'wf:runs:by-workflow:*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) ids.add(k.slice('wf:runs:by-workflow:'.length));
    } while (cursor !== '0');
    return [...ids];
  }

  /** In-memory fallback: the same retention, applied to the map. */
  private pruneMemRuns(workflowId: string): number {
    const ttl = runTtlSeconds();
    const cutoff = ttl > 0 ? Date.now() - ttl * 1000 : -Infinity;
    const runs = [...this.mem.runs.values()]
      .filter(x => x.workflow_id === workflowId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    let removed = 0;
    runs.forEach((run, i) => {
      if (i >= maxRunsPerWorkflow() || (Date.parse(run.created_at) || 0) < cutoff) {
        this.mem.runs.delete(run.run_id);
        removed += 1;
      }
    });
    return removed;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const r = this.r;
    if (r) {
      const raw = await r.get(`wf:run:${id}`);
      if (raw) return JSON.parse(raw) as WorkflowRun;
    }
    return this.mem.runs.get(id) ?? null;
  }

  async listRuns(workflowId: string, limit = 50): Promise<WorkflowRun[]> {
    const r = this.r;
    if (r) {
      const ids = await r.zrevrange(`wf:runs:by-workflow:${workflowId}`, 0, Math.max(0, limit - 1));
      if (ids.length === 0) return [];
      const raws = await r.mget(ids.map(id => `wf:run:${id}`));
      return raws.filter((x): x is string => !!x).map(x => JSON.parse(x) as WorkflowRun);
    }
    return [...this.mem.runs.values()]
      .filter(run => run.workflow_id === workflowId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  /* ── Per-run event stream (for SSE tail) ─────────────────────── */

  async appendRunEvent(runId: string, type: string, payload: Record<string, any>): Promise<void> {
    const r = this.r;
    if (!r) return;
    const key = `wf:stream:${runId}`;
    const ttl = runTtlSeconds();
    const tx = r.multi().xadd(
      key, 'MAXLEN', '~', String(STREAM_MAX_LEN), '*',
      'type', type,
      'payload', JSON.stringify(payload),
    );
    if (ttl > 0) tx.expire(key, ttl);
    await tx.exec();
  }

  /** Poll-style reader: returns entries with id > lastId. */
  async readRunEvents(runId: string, lastId = '0-0', blockMs = 5000):
    Promise<Array<{ id: string; type: string; payload: any }>> {
    const r = this.r;
    if (!r) return [];
    const key = `wf:stream:${runId}`;
    // XREAD BLOCK — returns null on timeout.
    const res = await r.xread('BLOCK', blockMs, 'STREAMS', key, lastId) as
      Array<[string, Array<[string, string[]]>]> | null;
    if (!res) return [];
    const out: Array<{ id: string; type: string; payload: any }> = [];
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        let payload: any = obj.payload;
        try { payload = JSON.parse(obj.payload); } catch { /* leave raw */ }
        out.push({ id, type: obj.type || 'event', payload });
      }
    }
    return out;
  }

  /** Replay all accumulated events for a run (catch-up before live tail). */
  async replayRunEvents(runId: string): Promise<Array<{ id: string; type: string; payload: any }>> {
    const r = this.r;
    if (!r) return [];
    const key = `wf:stream:${runId}`;
    const res = await r.xrange(key, '-', '+') as Array<[string, string[]]>;
    const out: Array<{ id: string; type: string; payload: any }> = [];
    for (const [id, fields] of res) {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      let payload: any = obj.payload;
      try { payload = JSON.parse(obj.payload); } catch { /* leave raw */ }
      out.push({ id, type: obj.type || 'event', payload });
    }
    return out;
  }

  /** Get the raw Redis instance for low-level operations (engine only). */
  getRaw(): Redis | null { return this.r; }
}
