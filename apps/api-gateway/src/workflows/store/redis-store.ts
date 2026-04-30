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
 *   wf:run:<rid>                    JSON  Run doc
 *   wf:stream:<rid>                 STREAM  per-run event stream (for SSE tail)
 *
 * If Redis is unavailable the store transparently falls back to an in-memory
 * map so the rest of the app keeps working; persistence is just lost across
 * gateway restarts (same degraded behaviour as RedisEventService).
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { Trigger, Workflow, WorkflowRun } from '../workflows.types';

const MAX_RUNS_PER_WORKFLOW = 200;
const STREAM_MAX_LEN = 500;

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
    this.mem.runs.set(run.run_id, run);
    const r = this.r;
    if (!r) return;
    const score = Date.parse(run.created_at) || Date.now();
    await r.multi()
      .set(`wf:run:${run.run_id}`, JSON.stringify(run))
      .zadd(`wf:runs:by-workflow:${run.workflow_id}`, score, run.run_id)
      .zremrangebyrank(`wf:runs:by-workflow:${run.workflow_id}`, 0, -1 - MAX_RUNS_PER_WORKFLOW)
      .exec();
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
    await r.xadd(
      key, 'MAXLEN', '~', String(STREAM_MAX_LEN), '*',
      'type', type,
      'payload', JSON.stringify(payload),
    );
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
