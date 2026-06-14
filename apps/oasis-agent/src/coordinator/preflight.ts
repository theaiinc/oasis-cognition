import { v4 as uuidv4 } from 'uuid';
import { HostCapacityService } from './host-capacity';
import { YggdrasilBridgeService } from './yggdrasil-bridge';
import { JobUsageService } from './job-usage';
import { JobBudgetService } from './job-budget';
import type {
  CoordinatorJob,
  CoordinatorTask,
  JobBudget,
  PlannerPlan,
  PreflightResult,
} from './types';

const RAM_PER_CHILD_MB = parseInt(process.env.RAM_PER_CHILD_MB || '1024', 10);
const DISK_PER_CHILD_GB = parseInt(process.env.DISK_PER_CHILD_GB || '1', 10);
const GPU_SLOTS = parseInt(process.env.GPU_SLOTS || '1', 10);
const SAFETY_FACTOR = parseFloat(process.env.JOB_BUDGET_SAFETY_FACTOR || '1.2');
const DEFAULT_USD_CAP = parseFloat(process.env.DEFAULT_JOB_BUDGET_USD || '5.0');

export class CoordinatorPreflightService {
  constructor(
    private readonly hostCapacity: HostCapacityService,
    private readonly yggdrasil: YggdrasilBridgeService,
    private readonly jobUsage: JobUsageService,
    private readonly jobBudget: JobBudgetService,
  ) {}

  async preflight(
    plan: PlannerPlan,
    parentSessionId: string,
    interactionId: string,
    autoApproveFree: boolean,
  ): Promise<PreflightResult> {
    const host = await this.hostCapacity.getCapacity();
    const admission = await this.yggdrasil.getAdmissionState();
    const planTasks = plan.tasks ?? [];
    const parallelCount = plan.parallel_groups?.length ?? 1;
    const taskCount = planTasks.length || plan.steps.length;

    const childEstimates: Array<{ task_id: string; usd_low: number; usd_high: number }> = [];
    let totalUsdLow = 0;
    let totalUsdHigh = 0;

    for (const t of planTasks) {
      const model = t.profile_id || null;
      const est = this.jobUsage.estimateCost(t, model);
      childEstimates.push({ task_id: t.id, usd_low: est.usd_low, usd_high: est.usd_high });
      totalUsdLow += est.usd_low;
      totalUsdHigh += est.usd_high;
    }

    if (planTasks.length === 0) {
      const perStep = (plan.steps.length || 1);
      totalUsdLow = perStep * 0.001;
      totalUsdHigh = perStep * 0.005;
    }

    const proposedUsdLimit = Math.max(DEFAULT_USD_CAP, Math.round(totalUsdHigh * SAFETY_FACTOR * 100) / 100);

    const ramChildLimit = host.ram_free_mb > 0 ? Math.floor(host.ram_free_mb / RAM_PER_CHILD_MB) : 1;
    const diskChildLimit = host.disk_free_gb > 0 ? Math.floor(host.disk_free_gb / DISK_PER_CHILD_GB) : 1;
    const gpuLimit = host.gpu_vram_mb !== null ? GPU_SLOTS : 999;
    const budgetChildLimit = proposedUsdLimit > 0 && totalUsdHigh > 0
      ? Math.max(1, Math.floor(proposedUsdLimit / (totalUsdHigh / Math.max(1, taskCount))))
      : taskCount;

    const parallel_allowed = Math.min(
      parallelCount,
      admission.available_slots + admission.healthy_count,
      ramChildLimit,
      diskChildLimit,
      gpuLimit,
      budgetChildLimit,
    );

    let degraded_mode: 'full' | 'sequential' | 'reduced' = 'full';
    const degradedParts: string[] = [];

    if (parallelCount < 2) {
      // Nothing to parallelise
    } else if (parallel_allowed < 1) {
      degraded_mode = 'sequential';
      degradedParts.push('no parallel slots available');
    } else if (parallel_allowed < parallelCount) {
      degraded_mode = 'reduced';
      if (parallel_allowed < ramChildLimit) degradedParts.push(`RAM (${Math.round(host.ram_free_mb / 1024)} GB free, estimated ${RAM_PER_CHILD_MB} MB/child)`);
      if (parallel_allowed < diskChildLimit) degradedParts.push(`disk (${host.disk_free_gb} GB free)`);
      if (admission.available_slots + admission.healthy_count < parallelCount) degradedParts.push(`worker capacity`);
      if (budgetChildLimit < parallelCount) degradedParts.push(`budget cap`);
    }

    const anyPaid = planTasks.some(t => t.billing_class === 'paid_api' || t.billing_class === 'subscription_external' || t.billing_class === 'uncertain');
    const noBillingClass = planTasks.length > 0 && planTasks.every(t => !t.billing_class);
    const hasCost = totalUsdHigh > 0 || noBillingClass;
    const approval_required = hasCost && !autoApproveFree;

    const job: CoordinatorJob = {
      job_id: uuidv4(),
      parent_session_id: parentSessionId,
      interaction_id: interactionId,
      plan,
      status: 'preflight',
      parallel_allowed,
      degraded_mode,
      degraded_reason: degradedParts.length > 0 ? degradedParts.join('; ') : undefined,
      est_usd_low: totalUsdLow,
      est_usd_high: totalUsdHigh,
      host_ram_mb: host.ram_free_mb,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const budget: JobBudget = {
      max_usd: proposedUsdLimit,
      max_tokens: 0,
      auto_approved: !approval_required,
      user_adjusted_limit: null,
      safety_factor: SAFETY_FACTOR,
    };

    return {
      job,
      budget,
      parallel_allowed,
      degraded_mode,
      degraded_reason: degradedParts.length > 0 ? degradedParts.join('; ') : undefined,
      host_capacity: host,
      approval_required,
      child_estimates: childEstimates,
    };
  }
}
