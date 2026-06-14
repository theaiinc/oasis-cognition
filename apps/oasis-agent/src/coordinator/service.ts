import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { RedisEventService } from './redis-events';
import { HostCapacityService } from './host-capacity';
import { YggdrasilBridgeService } from './yggdrasil-bridge';
import { CoordinatorPreflightService } from './preflight';
import { JobUsageService } from './job-usage';
import { JobBudgetService } from './job-budget';
import type {
  CoordinatorJob,
  CoordinatorTask,
  JobBudget,
  PlannerPlan,
  PreflightResult,
} from './types';
import { JOB_REDIS_KEY, JOB_BUDGET_KEY, JOB_CHILD_KEY } from './types';

export class CoordinatorService {
  private redis: Redis | null = null;
  private redisReady = false;
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
        .catch(() => console.warn('Redis unavailable; jobs held in memory only'));
    } catch {
      console.warn('Redis init failed; jobs held in memory only');
    }
  }

  async createJob(
    plan: PlannerPlan,
    parentSessionId: string,
    interactionId: string,
    autoApproveFree: boolean,
  ): Promise<PreflightResult> {
    const result = await this.preflight.preflight(plan, parentSessionId, interactionId, autoApproveFree);

    result.job.status = result.approval_required ? 'awaiting_approval' : 'draft';
    await this.persistJob(result.job);
    await this.jobBudget.setBudget(result.job.job_id, result.budget);

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

    if (!result.approval_required && result.job.status === 'draft') {
      result.job.status = 'running';
      await this.persistJob(result.job);
      await this.dispatchApprovedJob(result.job);
    }

    console.log(
      `Job ${result.job.job_id} created (status=${result.job.status}, tasks=${result.job.plan.tasks?.length ?? 0}, parallel=${result.parallel_allowed}, est_usd=${result.job.est_usd_low}-${result.job.est_usd_high})`,
    );
    return result;
  }

  async approveJob(jobId: string, userLimit?: number): Promise<CoordinatorJob> {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== 'awaiting_approval' && job.status !== 'draft') {
      throw new Error(`Cannot approve job in status ${job.status}`);
    }

    const budget = await this.jobBudget.getBudget(jobId);
    if (userLimit !== undefined) {
      budget.user_adjusted_limit = userLimit;
      budget.max_usd = userLimit;
    }
    budget.auto_approved = true;
    await this.jobBudget.setBudget(jobId, budget);

    await this.dispatchApprovedJob(job);
    return this.getJob(jobId) as Promise<CoordinatorJob>;
  }

  async cancelJob(jobId: string): Promise<CoordinatorJob> {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== 'running' && job.status !== 'awaiting_approval' && job.status !== 'preflight') {
      throw new Error(`Cannot cancel job in status ${job.status}`);
    }

    const children = await this.getChildren(jobId);
    for (const child of Object.values(children)) {
      if (child.child_session_id) {
        child.status = 'cancelled';
      }
    }
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
      } catch (err: any) {
        console.warn(`getJob redis: ${err}`);
      }
    }
    return null;
  }

  async listJobs(parentSessionId?: string): Promise<CoordinatorJob[]> {
    const all = Array.from(this.jobCache.values());
    const filtered = parentSessionId ? all.filter(j => j.parent_session_id === parentSessionId) : all;
    return filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

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

  async onChildReport(
    jobId: string,
    taskId: string,
    report: { status: string; model?: string; tokens?: { input: number; output: number }; final_message?: string },
  ): Promise<void> {
    await this.setChild(jobId, taskId, { task_id: taskId, child_session_id: undefined, status: report.status });

    if (report.tokens) {
      await this.jobUsage.addChildUsage(jobId, {
        input_tokens: report.tokens.input,
        output_tokens: report.tokens.output,
        model: report.model || null,
      });
    }

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

  private async dispatchApprovedJob(job: CoordinatorJob): Promise<void> {
    const admission = await this.yggdrasil.getAdmissionState();
    if (admission.circuit_breaker_open) {
      console.warn(`Job ${job.job_id} cannot dispatch: circuit breaker open`);
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
      for (const group of groups) {
        const groupTasks = tasks.filter(t => group.task_ids.includes(t.id));
        const promises = groupTasks.map(t => this.spawnChild(job.job_id, t, job.parent_session_id));
        await Promise.allSettled(promises);
      }
    } else {
      for (const t of tasks) {
        await this.spawnChild(job.job_id, t, job.parent_session_id);
      }
    }
  }

  private async spawnChild(jobId: string, task: CoordinatorTask, parentSessionId: string): Promise<void> {
    console.log(`Spawning child: job=${jobId}, task=${task.id}, goal=${task.goal.slice(0, 60)}`);

    const usage = await this.jobUsage.getUsage(jobId);
    const budgetCheck = await this.jobBudget.checkBudget(jobId, usage.cost_usd);
    if (budgetCheck.over) {
      console.warn(`Job ${jobId}: budget exceeded, not spawning ${task.id}`);
      await this.events.publish('SubagentBudgetWarn', parentSessionId, {
        job_id: jobId,
        pct: budgetCheck.pct,
        remaining_usd: 0,
        reason: budgetCheck.reason,
      });
      return;
    }

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
      console.warn(`Job ${jobId}: no runner available for task ${task.id}`);
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

    await this.events.publish('SubagentStarted', parentSessionId, {
      job_id: jobId,
      task_id: task.id,
      child_session_id: childHandle,
      goal: task.goal,
      runner_id: result.runnerId,
      ygg_task_id: result.taskId,
    });

    this.pollChildTask(jobId, task.id, result.runnerId, result.taskId, parentSessionId)
      .catch((err) => console.warn(`pollChildTask error: ${err.message}`));
  }

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

    const model = result.metadata?.model as string | undefined;
    const tokens = result.metadata?.tokens as { input: number; output: number } | undefined;

    await this.onChildReport(jobId, taskId, {
      status,
      model,
      tokens,
      final_message: finalMessage,
    });
  }

  private async persistJob(job: CoordinatorJob): Promise<void> {
    this.jobCache.set(job.job_id, job);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(JOB_REDIS_KEY, job.job_id, JSON.stringify(job)); }
      catch (err: any) { console.warn(`persistJob redis: ${err}`); }
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

  private async setChildren(jobId: string, children: Record<string, { task_id: string; child_session_id?: string; status: string }>): Promise<void> {
    await this.persistChildren(jobId, children);
  }

  private async persistChildren(jobId: string, children: Record<string, { task_id: string; child_session_id?: string; status: string }>): Promise<void> {
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(JOB_CHILD_KEY, jobId, JSON.stringify(children)); }
      catch (err: any) { console.warn(`persistChildren redis: ${err}`); }
    }
  }
}
