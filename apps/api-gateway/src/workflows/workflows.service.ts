/**
 * Workflows service — CRUD, manual run, cancel. Triggers live in a separate
 * service because their lifecycle (scheduler registration, event listener
 * bookkeeping) has more moving parts.
 */

import { HttpException, HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';

import { executeRun } from './engine';
import { WorkflowStore } from './store/redis-store';
import type {
  CreateWorkflowDto,
  RunWorkflowDto,
  UpdateWorkflowDto,
  Workflow,
  WorkflowRun,
} from './workflows.types';
import { ModuleRef } from '@nestjs/core';

export const RUN_QUEUE = 'workflow-runs';

function iso(): string { return new Date().toISOString(); }

interface RunJobData {
  workflow_id: string;
  trigger_id?: string;
  trigger_type?: 'cron' | 'event' | 'manual';
  input?: any;
  context?: Record<string, any>;
}

/** In-memory map of live AbortControllers for running jobs. Used by cancel(). */
const LIVE: Map<string, AbortController> = new Map();

@Injectable()
export class WorkflowsService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowsService.name);
  // Lazy-resolved to avoid the WorkflowsService ↔ TriggersService circular
  // DI (TriggersService depends on WorkflowsService for enqueueRun).
  private _triggers: { syncTriggerNodes: (wf: Workflow) => Promise<void> } | null = null;

  constructor(
    private readonly store: WorkflowStore,
    @InjectQueue(RUN_QUEUE) private readonly queue: Queue<RunJobData>,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    this.logger.log('WorkflowsService ready');
  }

  private async triggersSvc() {
    if (this._triggers) return this._triggers;
    // The concrete type is TriggersService, but importing it here would
    // introduce a cycle; resolve by name.
    const mod = await import('./triggers/triggers.service');
    const svc = this.moduleRef.get(mod.TriggersService, { strict: false });
    this._triggers = svc;
    return svc;
  }

  private async syncTriggerNodesFor(wf: Workflow): Promise<void> {
    try {
      const svc = await this.triggersSvc();
      await svc.syncTriggerNodes(wf);
    } catch (err: any) {
      this.logger.warn(`syncTriggerNodes failed for ${wf.workflow_id}: ${err.message}`);
    }
  }

  /* ── Workflows ────────────────────────────────────────────────── */

  async createWorkflow(dto: CreateWorkflowDto): Promise<Workflow> {
    if (!dto?.name?.trim()) {
      throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    }
    const now = iso();
    const wf: Workflow = {
      workflow_id: uuidv4(),
      name: dto.name.trim(),
      description: dto.description,
      version: 1,
      enabled: dto.enabled ?? true,
      nodes: dto.nodes ?? [],
      edges: dto.edges ?? [],
      created_at: now,
      updated_at: now,
    };
    await this.store.saveWorkflow(wf);
    await this.syncTriggerNodesFor(wf);
    return wf;
  }

  async getWorkflow(id: string): Promise<Workflow> {
    const wf = await this.store.getWorkflow(id);
    if (!wf) throw new HttpException('workflow not found', HttpStatus.NOT_FOUND);
    return wf;
  }

  async listWorkflows(): Promise<Workflow[]> {
    const list = await this.store.listWorkflows();
    return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async updateWorkflow(id: string, patch: UpdateWorkflowDto): Promise<Workflow> {
    const wf = await this.getWorkflow(id);
    const updated: Workflow = {
      ...wf,
      ...patch,
      workflow_id: wf.workflow_id,      // don't let callers change id
      created_at: wf.created_at,
      version: wf.version + 1,
      updated_at: iso(),
    };
    await this.store.saveWorkflow(updated);
    await this.syncTriggerNodesFor(updated);
    return updated;
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.getWorkflow(id);  // 404 if missing
    // Cascade: triggers + runs
    const triggers = await this.store.listTriggers(id);
    for (const t of triggers) await this.store.deleteTrigger(t.trigger_id);
    await this.store.deleteRunsForWorkflow(id);
    await this.store.deleteWorkflow(id);
  }

  /* ── Runs ─────────────────────────────────────────────────────── */

  async enqueueRun(
    workflowId: string,
    input?: any,
    opts: { trigger_id?: string; trigger_type?: RunJobData['trigger_type']; context?: Record<string, any> } = {},
  ): Promise<WorkflowRun> {
    const wf = await this.getWorkflow(workflowId);
    if (!wf.enabled) {
      throw new HttpException('workflow is disabled', HttpStatus.CONFLICT);
    }
    const run: WorkflowRun = {
      run_id: uuidv4(),
      workflow_id: wf.workflow_id,
      trigger_id: opts.trigger_id,
      trigger_type: opts.trigger_type ?? 'manual',
      status: 'queued',
      input,
      context: opts.context || {},
      node_states: {},
      created_at: iso(),
    };
    await this.store.saveRun(run);
    await this.store.appendRunEvent(run.run_id, 'status', { status: run.status });

    await this.queue.add('run', {
      workflow_id: wf.workflow_id,
      trigger_id: opts.trigger_id,
      trigger_type: run.trigger_type,
      input,
      context: opts.context,
    }, {
      // Surface the run id on the job for later correlation
      jobId: run.run_id,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return run;
  }

  async runNow(workflowId: string, dto: RunWorkflowDto): Promise<WorkflowRun> {
    return this.enqueueRun(workflowId, dto?.input, {
      trigger_type: 'manual',
      context: dto?.context || {},
    });
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new HttpException('run not found', HttpStatus.NOT_FOUND);
    return run;
  }

  async listRuns(workflowId: string, limit = 50): Promise<WorkflowRun[]> {
    return this.store.listRuns(workflowId, limit);
  }

  async cancelRun(runId: string): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (run.status !== 'running' && run.status !== 'queued') {
      return run;
    }
    const ctrl = LIVE.get(runId);
    if (ctrl) ctrl.abort();

    // If queued, try removing from the queue
    try {
      const job = await this.queue.getJob(runId);
      if (job && (await job.isWaiting() || await job.isDelayed())) {
        await job.remove();
      }
    } catch { /* ignore */ }

    run.status = 'cancelled';
    run.finished_at = iso();
    run.error = run.error || 'cancelled by user';
    await this.store.saveRun(run);
    await this.store.appendRunEvent(runId, 'status', { status: run.status });
    return run;
  }

  /* ── Executor entry point (called by the BullMQ worker) ──────── */

  async executeJob(data: RunJobData, runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) {
      this.logger.warn(`executeJob: run ${runId} not found`);
      return;
    }
    const wf = await this.store.getWorkflow(data.workflow_id);
    if (!wf) {
      run.status = 'failed';
      run.error = 'workflow no longer exists';
      run.finished_at = iso();
      await this.store.saveRun(run);
      return;
    }
    const ctrl = new AbortController();
    LIVE.set(runId, ctrl);
    try {
      await executeRun(run, wf, this.store, { abortSignal: ctrl.signal });
    } finally {
      LIVE.delete(runId);
    }
  }

  /* ── Accessors for other modules (triggers service) ──────────── */

  getStore(): WorkflowStore { return this.store; }
  getQueue(): Queue<RunJobData> { return this.queue; }
}
