/**
 * CoordinatorService — job lifecycle and dispatch orchestration.
 *
 * Flow:
 *   1. createJob(plan) → preflight → persist job + budget → return pending job
 *   2. approveJob(id, budget) → persist approved budget → dispatch children
 *   3. dispatchApprovedJob(id) → admission re-check → dispatch tasks to Yggdrasil runners
 *   4. On child terminal event → roll up usage → publish SubagentReport
 *   5. All children done → publish JobCompleted
 *
 * Dispatch model:
 *   Tasks are dispatched to Yggdrasil runners via the bridge's dispatchTask().
 *   Each runner (Ratatoskr daemon) picks up tasks assigned to it, executes them
 *   in-place using its own LLM/agent capabilities, and reports status back via
 *   heartbeats or direct PATCH to the Yggdrasil controller. The bridge's
 *   waitForTask() polls for terminal state.
 */

import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { RedisEventService } from '../events/redis-event.service';
import { HostCapacityService } from './host-capacity.service';
import { YggdrasilBridgeService } from './yggdrasil-bridge.service';
import { CoordinatorPreflightService } from './coordinator-preflight.service';
import { JobUsageService } from './job-usage.service';
import { JobBudgetService } from './job-budget.service';
import type {
  CoordinatorJob,
  CoordinatorTask,
  JobBudget,
  PlannerPlan,
  PreflightResult,
} from './coordinator.types';
import { JOB_REDIS_KEY, JOB_BUDGET_KEY, JOB_CHILD_KEY } from './coordinator.types';

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);
  private redis: Redis | null = null;
  private redisReady = false;

  /** In-memory job storage with Redis fallback. */
  private readonly jobCache = new Map<string, CoordinatorJob>();

  constructor(
    private readonly preflight: CoordinatorPreflightService,
    private readonly hostCapacity: HostCapacityService,
    private readonly yggdrasil: YggdrasilBridgeService,
    private readonly jobUsage: JobUsageService,
    private readonly jobBudget: JobBudgetService,
    private readonly events: RedisEventService,
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
        .catch(() => this.logger.warn('Redis unavailable; jobs held in memory only'));
    } catch {
      this.logger.warn('Redis init failed; jobs held in memory only');
    }
  }

  // ── Job CRUD ────────────────────────────────────────────────────────

  /** Run preflight, persist the result, and return the pending job. */
  async createJob(
    plan: PlannerPlan,
    parentSessionId: string,
    interactionId: string,
    autoApproveFree: boolean,
  ): Promise<PreflightResult> {
    const result = await this.preflight.preflight(plan, parentSessionId, interactionId, autoApproveFree);

    // Persist job + budget
    result.job.status = result.approval_required ? 'awaiting_approval' : 'draft';
    await this.persistJob(result.job);
    await this.jobBudget.setBudget(result.job.job_id, result.budget);

    // Publish preflight ready event so the UI can show the approval card
    await this.events.publish('CoordinatorPreflightReady', parentSessionId, {
      job_id: result.job.job_id,
      task_count: result.job.plan.tasks?.length ?? 0,
      parallel_allowed: result.parallel_allowed,
      degraded_mode: result.degraded_mode,
      degraded_reason: result.degraded_reason,
      est_usd_low: result.job.est_usd_low,
      est_usd_high: result.job.est_usd_high,
      host_ram_mb: result.host_capacity.ram_free_mb,
      approval_required: result.approval_required,
    });

    // Auto-dispatch if no approval needed
    if (!result.approval_required && result.job.status === 'draft') {
      result.job.status = 'running';
      await this.persistJob(result.job);
      await this.dispatchApprovedJob(result.job);
    }

    this.logger.log(
      `Job ${result.job.job_id} created (status=${result.job.status}, tasks=${result.job.plan.tasks?.length ?? 0}, parallel=${result.parallel_allowed}, est_usd=${result.job.est_usd_low}-${result.job.est_usd_high})`,
    );
    return result;
  }

  /** Approve a job and dispatch it. Returns the updated job. */
  async approveJob(jobId: string, userLimit?: number): Promise<CoordinatorJob> {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== 'awaiting_approval' && job.status !== 'draft') {
      throw new Error(`Cannot approve job in status ${job.status}`);
    }

    // Update budget with user-adjusted limit
    const budget = await this.jobBudget.getBudget(jobId);
    if (userLimit !== undefined) {
      budget.user_adjusted_limit = userLimit;
      budget.max_usd = userLimit;
    }
    budget.auto_approved = true;
    await this.jobBudget.setBudget(jobId, budget);

    // Start dispatch
    await this.dispatchApprovedJob(job);
    return this.getJob(jobId) as Promise<CoordinatorJob>;
  }

  /** Cancel a running job — sets status and marks in-flight children as cancelled. */
  async cancelJob(jobId: string): Promise<CoordinatorJob> {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== 'running' && job.status !== 'awaiting_approval' && job.status !== 'preflight') {
      throw new Error(`Cannot cancel job in status ${job.status}`);
    }

    // Mark all children as cancelled (Yggdrasil runners will notice and abort)
    const children = await this.getChildren(jobId);
    for (const child of Object.values(children)) {
      if (child.child_session_id) {
        child.status = 'cancelled';
      }
    }
    // Persist all-child cancel via first child key write
    await this.setChildren(jobId, children);

    job.status = 'cancelled';
    job.updated_at = new Date().toISOString();
    await this.persistJob(job);

    await this.events.publish('JobCompleted', job.parent_session_id, {
      job_id: job.job_id,
      status: 'cancelled',
      total_cost: 0,
      total_time_ms: 0,
    });
    return job;
  }

  async getJob(jobId: string): Promise<CoordinatorJob | null> {
    if (this.jobCache.has(jobId)) return this.jobCache.get(jobId)!;
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(JOB_REDIS_KEY, jobId);
        if (v) {
          const parsed = JSON.parse(v) as CoordinatorJob;
          this.jobCache.set(jobId, parsed);
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`getJob redis: ${err}`);
      }
    }
    return null;
  }

  async listJobs(parentSessionId?: string): Promise<CoordinatorJob[]> {
    const all = Array.from(this.jobCache.values());
    const filtered = parentSessionId ? all.filter(j => j.parent_session_id === parentSessionId) : all;
    return filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // ── Dispatch ────────────────────────────────────────────────────────

  private async dispatchApprovedJob(job: CoordinatorJob): Promise<void> {
    const admission = await this.yggdrasil.getAdmissionState();
    if (admission.circuit_breaker_open) {
      this.logger.warn(`Job ${job.job_id} cannot dispatch: circuit breaker open`);
      job.status = 'failed';
      job.error = 'All workers unhealthy (circuit breaker open)';
      job.updated_at = new Date().toISOString();
      await this.persistJob(job);
      await this.events.publish('JobCompleted', job.parent_session_id, {
        job_id: job.job_id,
        status: 'failed',
        error: job.error,
        total_cost: 0,
        total_time_ms: 0,
      });
      return;
    }

    job.status = 'running';
    job.updated_at = new Date().toISOString();
    await this.persistJob(job);

    const tasks = job.plan.tasks ?? [];
    const groups = job.plan.parallel_groups ?? [];

    if (groups.length > 0 && job.parallel_allowed >= 1) {
      // Dispatch parallel groups
      for (const group of groups) {
        const groupTasks = tasks.filter(t => group.task_ids.includes(t.id));
        const promises = groupTasks.map(t => this.spawnChild(job.job_id, t, job.parent_session_id));
        await Promise.allSettled(promises);
      }
    } else {
      // Sequential dispatch
      for (const t of tasks) {
        await this.spawnChild(job.job_id, t, job.parent_session_id);
      }
    }
  }

  private async spawnChild(jobId: string, task: CoordinatorTask, parentSessionId: string): Promise<void> {
    this.logger.log(`Spawning child: job=${jobId}, task=${task.id}, goal=${task.goal.slice(0, 60)}`);

    // Check budget before dispatch
    const usage = await this.jobUsage.getUsage(jobId);
    const budgetCheck = await this.jobBudget.checkBudget(jobId, usage.cost_usd);
    if (budgetCheck.over) {
      this.logger.warn(`Job ${jobId}: budget exceeded, not spawning ${task.id}`);
      await this.events.publish('SubagentBudgetWarn', parentSessionId, {
        job_id: jobId,
        pct: budgetCheck.pct,
        remaining_usd: 0,
        reason: budgetCheck.reason,
      });
      return;
    }

    // Dispatch task to a Yggdrasil runner with agent capability.
    // The runner's Ratatoskr daemon will pick up the task and execute it.
    const result = await this.yggdrasil.dispatchTask({
      goal: task.goal,
      jobId,
      taskId: task.id,
      type: task.profile_id === 'shell' ? 'shell' : 'agent',
      profileId: task.profile_id,
      correlationId: jobId,
      requiredCapability: task.resource_class === 'gpu' ? 'gpu' : 'agent',
    });

    if (!result) {
      this.logger.warn(`Job ${jobId}: no runner available for task ${task.id}`);
      await this.events.publish('SubagentReport', parentSessionId, {
        job_id: jobId,
        task_id: task.id,
        status: 'failed',
        final_message: 'No Yggdrasil runner available with required capability',
      });
      await this.setChild(jobId, task.id, {
        task_id: task.id,
        child_session_id: undefined,
        status: 'failed',
      });
      return;
    }

    const childHandle = `ygg:${result.runnerId}:${result.taskId}`;
    const childMapping = { task_id: task.id, child_session_id: childHandle, status: 'running' };
    await this.setChild(jobId, task.id, childMapping);

    // Publish started event
    await this.events.publish('SubagentStarted', parentSessionId, {
      job_id: jobId,
      task_id: task.id,
      child_session_id: childHandle,
      goal: task.goal,
      runner_id: result.runnerId,
      ygg_task_id: result.taskId,
    });

    // Poll for completion in background — child status updates come via
    // runner heartbeats to Yggdrasil, which we poll through the bridge.
    this.pollChildTask(jobId, task.id, result.runnerId, result.taskId, parentSessionId)
      .catch((err) => this.logger.warn(`pollChildTask error: ${err.message}`));
  }

  /**
   * Poll a Yggdrasil runner task until completion, then aggregate results.
   * Runs asynchronously after dispatchTask returns.
   */
  private async pollChildTask(
    jobId: string,
    taskId: string,
    runnerId: string,
    yggTaskId: string,
    parentSessionId: string,
  ): Promise<void> {
    const result = await this.yggdrasil.waitForTask(runnerId, yggTaskId, 3000, 600_000);

    const status = result.status === 'completed' ? 'completed' : 'failed';
    const finalMessage =
      result.metadata?.final_message as string | undefined ||
      (status === 'completed' ? `Task "${taskId}" completed` : `Task failed: ${result.error}`);

    // Extract token usage and model from metadata (cost is computed server-side)
    const model = result.metadata?.model as string | undefined;
    const tokens = result.metadata?.tokens as { input: number; output: number } | undefined;

    // Record the report
    await this.onChildReport(jobId, taskId, {
      status,
      model,
      tokens,
      final_message: finalMessage,
    });
  }

  /** Called when a container-based child reports that it has started. */
  async onChildStarted(jobId: string, taskId: string, childSessionId?: string): Promise<void> {
    const childMapping = {
      task_id: taskId,
      child_session_id: childSessionId || `container-${taskId}`,
      status: 'running' as const,
    };
    await this.setChild(jobId, taskId, childMapping);

    const job = await this.getJob(jobId);
    await this.events.publish('SubagentStarted', job?.parent_session_id || '', {
      job_id: jobId,
      task_id: taskId,
      child_session_id: childSessionId,
      goal: job?.plan.tasks?.find(t => t.id === taskId)?.goal || '',
    });
  }

  /** Called when a child reaches terminal state. Aggregates results. */
  async onChildReport(
    jobId: string,
    taskId: string,
    report: { status: string; model?: string; tokens?: { input: number; output: number }; final_message?: string },
  ): Promise<void> {
    await this.setChild(jobId, taskId, { task_id: taskId, child_session_id: undefined, status: report.status });

    // Aggregate into job totals — cost computed server-side by JobUsageService
    if (report.tokens) {
      await this.jobUsage.addChildUsage(jobId, {
        input_tokens: report.tokens.input,
        output_tokens: report.tokens.output,
        model: report.model || null,
      });
    }

    // Check if all children done
    const children = await this.getChildren(jobId);
    const allDone = Object.values(children).every(c => c.status !== 'running' && c.status !== 'creating');
    if (allDone) {
      const job = await this.getJob(jobId);
      if (job) {
        job.status = 'completed';
        job.updated_at = new Date().toISOString();
        await this.persistJob(job);
      }
      const finalUsage = await this.jobUsage.getUsage(jobId);
      await this.events.publish('JobCompleted', job?.parent_session_id || '', {
        job_id: jobId,
        status: 'completed',
        total_cost: finalUsage.cost_usd,
        total_tokens: finalUsage.input_tokens + finalUsage.output_tokens,
        total_time_ms: 0,
      });
    }
  }

  // ── Redis persistence ───────────────────────────────────────────────

  private async persistJob(job: CoordinatorJob): Promise<void> {
    this.jobCache.set(job.job_id, job);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(JOB_REDIS_KEY, job.job_id, JSON.stringify(job)); }
      catch (err) { this.logger.warn(`persistJob redis: ${err}`); }
    }
  }

  private async getChildren(jobId: string): Promise<Record<string, { task_id: string; child_session_id?: string; status: string }>> {
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(JOB_CHILD_KEY, jobId);
        if (v) return JSON.parse(v);
      } catch { /* fallback */ }
    }
    return {};
  }

  private async setChild(jobId: string, taskId: string, mapping: { task_id: string; child_session_id?: string; status: string }): Promise<void> {
    const children = await this.getChildren(jobId);
    children[taskId] = mapping;
    await this.persistChildren(jobId, children);
  }

  /** Bulk-write all children at once (used by cancelJob). */
  private async setChildren(jobId: string, children: Record<string, { task_id: string; child_session_id?: string; status: string }>): Promise<void> {
    await this.persistChildren(jobId, children);
  }

  private async persistChildren(jobId: string, children: Record<string, { task_id: string; child_session_id?: string; status: string }>): Promise<void> {
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(JOB_CHILD_KEY, jobId, JSON.stringify(children)); }
      catch (err) { this.logger.warn(`persistChildren redis: ${err}`); }
    }
  }
}
