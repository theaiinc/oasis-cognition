/**
 * Shared types for the coordinator module.
 *
 * The coordinator manages one "job" (a user task decomposed into parallel
 * subtasks), handles capacity + cost preflight, and orchestrates dispatch.
 */

import type { ExternalAgentSession, PermissionMode } from '../external-agents/external-agents.types';

// ── Billing / Resource classes ──────────────────────────────────────────

/** How an agent profile is billed. Used by the preflight service to
 *  decide whether a job needs user budget approval. */
export type BillingClass =
  | 'free_local'        // local inference (Ollama MLX, etc.) — $0
  | 'paid_api'          // token-metered API (Claude, GPT)
  | 'subscription_external' // external CLI (Claude Code, Cursor)
  | 'uncertain';        // unknown — treated as paid

/** Rough resource footprint class for a child agent. */
export type ResourceClass = 'light' | 'standard' | 'gpu';

// ── Job types ───────────────────────────────────────────────────────────

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
  depends_on: string[];          // task ids that must finish first
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
  parallel_allowed: number;       // computed by preflight
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
  user_adjusted_limit: number | null; // null = used proposed default
  safety_factor: number;              // default 1.2
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
  child_session_id?: string;   // external-agents session id
  status: string;
}

// ── Worker backend abstraction ──────────────────────────────────────────

/** Interface abstracting how a subtask is executed — host CLI (v1) or
 *  future Docker agent pool. */
export interface WorkerBackend {
  /** Reserve a slot and spawn a worker for the given task. Returns a
   *  worker handle (child_session_id or ygg agent id). */
  spawn(sessionId: string, task: CoordinatorTask, parentJobId: string): Promise<string>;
  /** Check if the worker is still alive / done. */
  checkStatus(handle: string): Promise<{ done: boolean; error?: string }>;
  /** Kill the worker. */
  kill(handle: string): Promise<void>;
  /** Estimate the cost of a task before spawning. */
  estimateCost(task: CoordinatorTask): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number };
}

// ── Preflight result ────────────────────────────────────────────────────

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

// ── Redis keys ──────────────────────────────────────────────────────────

export const JOB_REDIS_KEY = 'oasis:job';
export const JOB_BUDGET_KEY = 'oasis:job_budget';
export const JOB_USAGE_KEY = 'oasis:job_usage';
export const JOB_CHILD_KEY = 'oasis:job_child';
