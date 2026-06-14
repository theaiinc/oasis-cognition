/**
 * Native tool dispatchers for the Coordinator (parallel subagent) abstraction.
 *
 * `delegate_tasks` lets the chat agent decompose a goal into parallel subtasks,
 * run preflight (capacity + cost), and optionally wait for user approval before
 * dispatching workers. Results arrive via SubagentReport events.
 */

import axios from 'axios';

const OASIS_AGENT_URL = process.env.OASIS_AGENT_URL || 'http://oasis-agent:8020';
const API = `${OASIS_AGENT_URL}/api/v1/coordinator`;

export const NATIVE_COORDINATOR_TOOLS = new Set([
  'delegate_tasks',
  'delegate_job_status',
  'delegate_job_cancel',
]);

export interface NativeCoordinatorPlan {
  tool: string;
  /** The overall goal for this job. */
  goal?: string;
  /** Steps the parent agent plans to achieve. */
  steps?: Array<{ description: string; tool?: string; verify?: string }>;
  /** Success criteria for the overall job. */
  success_criteria?: string[];
  /** Parallel groups — tasks within the same group can run concurrently. */
  parallel_groups?: Array<{ id: string; task_ids: string[] }>;
  /** Individual task definitions. */
  tasks?: Array<{
    id: string;
    goal: string;
    profile_id?: string;
    billing_class?: string;
    resource_class?: string;
    depends_on?: string[];
  }>;
  /** The parent session for digest / report events. */
  parent_session_id?: string;
  /** Whether to auto-approve free (local) tasks without a card. */
  auto_approve_free?: boolean;
}

export async function dispatchNativeCoordinatorTool(
  plan: NativeCoordinatorPlan,
  sessionId: string,
): Promise<{ success: boolean; output: string }> {
  switch (plan.tool) {
    case 'delegate_tasks': {
      const steps = plan.steps || [{ description: plan.goal || 'Execute delegated tasks' }];
      const success_criteria = plan.success_criteria || ['All tasks completed'];
      const payload = {
        plan: {
          steps,
          success_criteria,
          parallel_groups: plan.parallel_groups || [],
          tasks: (plan.tasks || []).map(t => ({
            ...t,
            billing_class: (t.billing_class || 'free_local') as any,
            resource_class: (t.resource_class || 'light') as any,
            depends_on: t.depends_on || [],
          })),
        },
        parent_session_id: sessionId,
        interaction_id: '',
        auto_approve_free: plan.auto_approve_free !== false,
      };
      const res = await axios.post(`${API}/jobs`, payload, { timeout: 15_000 });
      const d = res.data;
      if (!d.ok) return { success: false, output: d.error || 'delegate_tasks failed' };
      return {
        success: true,
        output: [
          `Job created: ${d.job_id}`,
          `Status: ${d.job.status}`,
          `Parallel allowed: ${d.parallel_allowed}`,
          `Degraded: ${d.degraded_mode}${d.degraded_reason ? ` (${d.degraded_reason})` : ''}`,
          `Estimated cost: $${d.est_usd_low} - $${d.est_usd_high}`,
          d.approval_required ? 'Awaiting user approval — present the cost card to the user.' : 'Auto-approved and dispatched.',
        ].join('\n'),
      };
    }

    case 'delegate_job_status': {
      const jobId = (plan as any).job_id;
      if (!jobId) return { success: false, output: 'job_id is required for delegate_job_status' };
      const res = await axios.get(`${API}/jobs/${jobId}`, { timeout: 5000 });
      const job = res.data;
      return {
        success: true,
        output: [
          `Job: ${job.job_id}`,
          `Status: ${job.status}`,
          `Tasks: ${(job.plan?.tasks || []).length}`,
          `Estimated cost: $${job.est_usd_low ?? 0} - $${job.est_usd_high ?? 0}`,
        ].join('\n'),
      };
    }

    case 'delegate_job_cancel': {
      const jobId = (plan as any).job_id;
      if (!jobId) return { success: false, output: 'job_id is required for delegate_job_cancel' };
      const res = await axios.post(`${API}/jobs/${jobId}/cancel`, {}, { timeout: 10_000 });
      const d = res.data;
      return {
        success: d.ok,
        output: d.ok ? `Job ${jobId} cancelled.` : d.error || 'cancel failed',
      };
    }

    default:
      return { success: false, output: `Unknown coordinator tool: ${plan.tool}` };
  }
}
