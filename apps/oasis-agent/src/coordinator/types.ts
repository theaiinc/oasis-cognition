export type BillingClass =
  | 'free_local'
  | 'paid_api'
  | 'subscription_external'
  | 'uncertain';

export type ResourceClass = 'light' | 'standard' | 'gpu';

export type JobStatus =
  | 'draft'
  | 'preflight'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CoordinatorTask {
  id: string;
  goal: string;
  profile_id?: string;
  billing_class?: BillingClass;
  resource_class?: ResourceClass;
  depends_on: string[];
  est_input_tokens?: number;
  est_output_tokens?: number;
  est_cost_usd?: number;
}

export interface ParallelGroup {
  id: string;
  task_ids: string[];
}

export interface PlannerPlan {
  steps: Array<{ description: string; tool?: string; verify?: string }>;
  success_criteria: string[];
  parallel_groups?: ParallelGroup[];
  tasks?: CoordinatorTask[];
}

export interface CoordinatorJob {
  job_id: string;
  parent_session_id: string;
  interaction_id: string;
  plan: PlannerPlan;
  status: JobStatus;
  parallel_allowed: number;
  degraded_mode: 'full' | 'sequential' | 'reduced';
  degraded_reason?: string;
  est_usd_low: number;
  est_usd_high: number;
  host_ram_mb: number;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface JobBudget {
  max_usd: number;
  max_tokens: number;
  auto_approved: boolean;
  user_adjusted_limit: number | null;
  safety_factor: number;
}

export interface JobUsage {
  job_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_known: boolean;
  last_model: string | null;
  last_provider: string | null;
  last_updated: string;
}

export interface JobChildMapping {
  task_id: string;
  child_session_id?: string;
  status: string;
}

export interface WorkerBackend {
  spawn(sessionId: string, task: CoordinatorTask, parentJobId: string): Promise<string>;
  checkStatus(handle: string): Promise<{ done: boolean; error?: string }>;
  kill(handle: string): Promise<void>;
  estimateCost(task: CoordinatorTask): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number };
}

export interface PreflightResult {
  job: CoordinatorJob;
  budget: JobBudget;
  parallel_allowed: number;
  degraded_mode: 'full' | 'sequential' | 'reduced';
  degraded_reason?: string;
  host_capacity: HostCapacitySnapshot;
  approval_required: boolean;
  child_estimates: Array<{ task_id: string; usd_low: number; usd_high: number }>;
}

export interface HostCapacitySnapshot {
  ram_total_mb: number;
  ram_free_mb: number;
  disk_free_gb: number;
  cpu_cores: number;
  gpu_vram_mb: number | null;
  npu_available: boolean;
  fetched_at: string;
}

// ── Event payloads ────────────────────────────────────────────────────

export interface EventPayload {
  /** Redis channel name (e.g. 'CoordinatorPreflightReady', 'SubagentReport'). */
  channel: string;
  /** Session ID for UI subscription filter. */
  session_id: string;
  /** Arbitrary event data. */
  data: Record<string, unknown>;
}

export interface TaskResult {
  status: string;
  final_message: string;
  model: string | null;
  tokens: { input: number; output: number };
}

export const JOB_REDIS_KEY = 'oasis:job';
export const JOB_BUDGET_KEY = 'oasis:job_budget';
export const JOB_USAGE_KEY = 'oasis:job_usage';
export const JOB_CHILD_KEY = 'oasis:job_child';
