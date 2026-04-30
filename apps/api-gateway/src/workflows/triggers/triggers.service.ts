/**
 * Triggers CRUD + scheduler sync.
 *
 * Responsibilities:
 *   • Persist triggers in Redis (via WorkflowStore).
 *   • On create/update/delete: update the BullMQ cron scheduler OR the event
 *     listener's in-memory index accordingly.
 *   • Fire workflow runs when triggers match.
 */

import { HttpException, HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
// cron-parser's CJS default export is the module object; use a named require
// so we don't trip over the TS interop defaults.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser: { parseExpression: (expr: string, opts?: { tz?: string }) => any } = require('cron-parser');
import { v4 as uuidv4 } from 'uuid';

import { WorkflowStore } from '../store/redis-store';
import { WorkflowsService, RUN_QUEUE } from '../workflows.service';
import type { CreateTriggerDto, Trigger, TriggerConfig, TriggerType } from '../workflows.types';

function iso(): string { return new Date().toISOString(); }

const REPEAT_JOB_NAME = 'cron-trigger';

@Injectable()
export class TriggersService implements OnModuleInit {
  private readonly logger = new Logger(TriggersService.name);

  constructor(
    private readonly store: WorkflowStore,
    private readonly workflows: WorkflowsService,
    @InjectQueue(RUN_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    // Re-register all cron triggers on startup so repeatables are current.
    try {
      const triggers = await this.store.listTriggers();
      for (const t of triggers.filter(t => t.enabled && t.type === 'cron')) {
        await this.registerCronRepeatable(t);
      }
      this.logger.log(`Triggers initialised (${triggers.length} known)`);
    } catch (err: any) {
      this.logger.warn(`Failed to initialise triggers on startup: ${err.message}`);
    }
  }

  /* ── CRUD ─────────────────────────────────────────────────────── */

  async createTrigger(workflowId: string, dto: CreateTriggerDto): Promise<Trigger> {
    await this.workflows.getWorkflow(workflowId); // 404 if missing

    if (!dto?.type) throw new HttpException('type is required', HttpStatus.BAD_REQUEST);
    this.validateConfig(dto.type, dto.config);

    const now = iso();
    const trigger: Trigger = {
      trigger_id: uuidv4(),
      workflow_id: workflowId,
      type: dto.type,
      enabled: dto.enabled ?? true,
      config: dto.config ?? {},
      source: 'tab',
      created_at: now,
      updated_at: now,
    };
    await this.store.saveTrigger(trigger);
    await this.syncTrigger(trigger, null);
    return trigger;
  }

  async getTrigger(id: string): Promise<Trigger> {
    const t = await this.store.getTrigger(id);
    if (!t) throw new HttpException('trigger not found', HttpStatus.NOT_FOUND);
    return t;
  }

  async listTriggers(workflowId?: string): Promise<Trigger[]> {
    return this.store.listTriggers(workflowId);
  }

  async updateTrigger(id: string, patch: Partial<CreateTriggerDto>): Promise<Trigger> {
    const prev = await this.getTrigger(id);
    if (patch.type && patch.type !== prev.type) {
      throw new HttpException('type cannot change; delete + recreate', HttpStatus.BAD_REQUEST);
    }
    const updated: Trigger = {
      ...prev,
      ...patch,
      trigger_id: prev.trigger_id,
      workflow_id: prev.workflow_id,
      created_at: prev.created_at,
      updated_at: iso(),
    };
    if (updated.config) this.validateConfig(updated.type, updated.config);
    await this.store.saveTrigger(updated);
    await this.syncTrigger(updated, prev);
    return updated;
  }

  async deleteTrigger(id: string): Promise<void> {
    const t = await this.getTrigger(id);
    await this.store.deleteTrigger(id);
    if (t.type === 'cron') await this.removeCronRepeatable(t);
    // Event triggers clear automatically on next index rebuild — poke listener
    // by checking enabled list. The listener re-reads per event so no-op here.
  }

  /* ── Trigger-node sync (called from WorkflowsService on save) ─── */

  /**
   * Reconcile trigger records against the `trigger` nodes on a workflow's
   * canvas. The canvas is the source of truth for `source="node"` triggers;
   * this method never touches triggers authored via the side tab
   * (`source !== "node"`).
   *
   * Strategy:
   *   1. List existing source="node" triggers for the workflow.
   *   2. Walk workflow.nodes where type === "trigger".
   *   3. Match existing ↔ canvas by `source_node_id`.
   *   4. Create missing / update mismatched / delete abandoned.
   */
  async syncTriggerNodes(workflow: { workflow_id: string; nodes?: Array<{ id: string; type: string; params?: Record<string, any> }> }): Promise<void> {
    const triggerNodes = (workflow.nodes || []).filter(n => n.type === 'trigger');
    const existing = (await this.listTriggers(workflow.workflow_id))
      .filter(t => t.source === 'node');
    const byNodeId = new Map(existing.filter(t => t.source_node_id).map(t => [t.source_node_id!, t] as const));
    const seenNodeIds = new Set<string>();

    for (const n of triggerNodes) {
      seenNodeIds.add(n.id);
      const { type, config, enabled } = this._triggerFromNodeParams(n.params || {});
      if (!type) continue;                     // node is incomplete — skip silently
      if (type === 'manual') continue;         // manual triggers don't need a Trigger record
      try { this.validateConfig(type, config); }
      catch (err: any) { this.logger.warn(`Skipping trigger node ${n.id}: ${err.message}`); continue; }

      const prev = byNodeId.get(n.id);
      if (!prev) {
        await this.createTriggerInternal({
          workflow_id: workflow.workflow_id,
          type, config, enabled,
          source: 'node', source_node_id: n.id,
        });
      } else {
        await this.updateTriggerInternal(prev, { type, config, enabled });
      }
    }

    // Delete triggers whose source node no longer exists
    for (const t of existing) {
      if (t.source_node_id && !seenNodeIds.has(t.source_node_id)) {
        await this.deleteTrigger(t.trigger_id);
      }
    }
  }

  /** Parse a trigger node's params into a Trigger config. */
  private _triggerFromNodeParams(params: Record<string, any>): { type?: TriggerType; config: TriggerConfig; enabled: boolean } {
    const type = params.trigger_type as TriggerType | undefined;
    const enabled = params.enabled !== false;
    if (type === 'cron') {
      return {
        type,
        config: {
          expression: String(params.cron_expression || '* * * * *'),
          timezone: String(params.cron_timezone || 'UTC'),
        },
        enabled,
      };
    }
    if (type === 'event') {
      const filterRaw = params.event_filter;
      let filter: Record<string, any> | undefined;
      if (typeof filterRaw === 'object' && filterRaw !== null) filter = filterRaw;
      else if (typeof filterRaw === 'string' && filterRaw.trim()) {
        try { filter = JSON.parse(filterRaw); } catch { filter = undefined; }
      }
      return {
        type,
        config: {
          event_type: params.event_type ? String(params.event_type) : undefined,
          ...(filter ? { filter } : {}),
        },
        enabled,
      };
    }
    if (type === 'manual') return { type, config: {}, enabled };
    return { type: undefined, config: {}, enabled };
  }

  /** Create a Trigger directly (bypassing the public DTO-based create for sync-path use). */
  private async createTriggerInternal(opts: {
    workflow_id: string;
    type: TriggerType;
    config: TriggerConfig;
    enabled: boolean;
    source: 'node' | 'tab';
    source_node_id?: string;
  }): Promise<Trigger> {
    const now = iso();
    const trigger: Trigger = {
      trigger_id: uuidv4(),
      workflow_id: opts.workflow_id,
      type: opts.type,
      enabled: opts.enabled,
      config: opts.config,
      source: opts.source,
      source_node_id: opts.source_node_id,
      created_at: now,
      updated_at: now,
    };
    await this.store.saveTrigger(trigger);
    await this.syncTrigger(trigger, null);
    return trigger;
  }

  /** Update a Trigger in-place (used by sync path). */
  private async updateTriggerInternal(prev: Trigger, patch: { type: TriggerType; config: TriggerConfig; enabled: boolean }): Promise<void> {
    const typeChanged = patch.type !== prev.type;
    const configChanged = JSON.stringify(patch.config) !== JSON.stringify(prev.config);
    const enabledChanged = patch.enabled !== prev.enabled;
    if (!typeChanged && !configChanged && !enabledChanged) return;
    if (typeChanged) {
      // Re-register: delete + create to keep the scheduler clean.
      await this.deleteTrigger(prev.trigger_id);
      await this.createTriggerInternal({
        workflow_id: prev.workflow_id,
        type: patch.type, config: patch.config, enabled: patch.enabled,
        source: prev.source || 'node',
        source_node_id: prev.source_node_id,
      });
      return;
    }
    const updated: Trigger = {
      ...prev,
      config: patch.config,
      enabled: patch.enabled,
      updated_at: iso(),
    };
    await this.store.saveTrigger(updated);
    await this.syncTrigger(updated, prev);
  }

  /* ── Event matching (called by event-listener) ───────────────── */

  async fireMatchingEventTriggers(event: { event_type: string; payload: any; [k: string]: any }): Promise<void> {
    const triggers = (await this.listTriggers()).filter(t => t.type === 'event' && t.enabled);
    for (const t of triggers) {
      if (this.eventMatches(t.config, event)) {
        try {
          await this.workflows.enqueueRun(t.workflow_id, event, {
            trigger_id: t.trigger_id,
            trigger_type: 'event',
          });
        } catch (err: any) {
          this.logger.warn(`event trigger ${t.trigger_id} failed to enqueue: ${err.message}`);
        }
      }
    }
  }

  /* ── Internals ────────────────────────────────────────────────── */

  // validateConfig is public to the class so the sync helpers above can use
  // the same rules; keeping the implementation below unchanged.
  private validateConfig(type: TriggerType, config: TriggerConfig): void {
    if (type === 'cron') {
      const c = config as { expression?: string; timezone?: string };
      if (!c.expression) throw new HttpException('config.expression is required', HttpStatus.BAD_REQUEST);
      try { parser.parseExpression(c.expression, { tz: c.timezone }); }
      catch (err: any) { throw new HttpException(`invalid cron: ${err.message}`, HttpStatus.BAD_REQUEST); }
    }
    // event + manual: config is optional / shape-free
  }

  private async syncTrigger(next: Trigger, prev: Trigger | null): Promise<void> {
    if (next.type === 'cron') {
      if (prev?.type === 'cron') await this.removeCronRepeatable(prev);
      if (next.enabled) await this.registerCronRepeatable(next);
    }
    // Event triggers don't need per-trigger registration — the listener scans
    // all enabled event triggers on each event.
  }

  private async registerCronRepeatable(trigger: Trigger): Promise<void> {
    const cfg = trigger.config as { expression: string; timezone?: string };
    try {
      await this.queue.add(REPEAT_JOB_NAME, {
        trigger_id: trigger.trigger_id,
        workflow_id: trigger.workflow_id,
      }, {
        repeat: {
          pattern: cfg.expression,
          tz: cfg.timezone,
          key: `cron-${trigger.trigger_id}`,
        },
        removeOnComplete: 20,
        removeOnFail: 20,
      });
      this.logger.log(`cron registered: ${trigger.trigger_id} (${cfg.expression} ${cfg.timezone || 'UTC'})`);
    } catch (err: any) {
      this.logger.warn(`registerCronRepeatable ${trigger.trigger_id} failed: ${err.message}`);
    }
  }

  private async removeCronRepeatable(trigger: Trigger): Promise<void> {
    try {
      await this.queue.removeJobScheduler(`cron-${trigger.trigger_id}`);
    } catch (err: any) {
      this.logger.debug(`removeCronRepeatable ${trigger.trigger_id}: ${err.message}`);
    }
  }

  private eventMatches(config: TriggerConfig, event: { event_type: string; payload: any; [k: string]: any }): boolean {
    const c = config as { event_type?: string; filter?: Record<string, any> };
    if (c.event_type && c.event_type !== event.event_type) return false;
    if (c.filter) {
      for (const [path, expected] of Object.entries(c.filter)) {
        if (getByPath(event, path) !== expected) return false;
      }
    }
    return true;
  }
}

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
