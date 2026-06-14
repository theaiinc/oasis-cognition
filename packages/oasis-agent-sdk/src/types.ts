/** Shared types for the Oasis Agent SDK. */

// ── Coordinator types ───────────────────────────────────────────────────────

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
  child_task_id?: string;
  status?: string;
  runner_id?: string;
}

export interface HostCapacitySnapshot {
  ram: {
    total_mb: number;
    free_mb: number;
    used_mb: number;
    available_mb: number;
    percent: number;
  };
  cpu: { percent: number; cores: number };
  gpu: {
    available: boolean;
    model?: string;
    vram_total_mb?: number;
    vram_free_mb?: number;
  };
  containers: { running: number; max: number };
  concurrency: { running_builds: number; max_builds: number; running_agents: number; max_agents: number };
  resources: { default_image: string; default_max_ram_mb: number; default_max_swap_mb: number; default_cpu_quota: number };
}

export interface CreateJobResult {
  ok: boolean;
  job_id: string;
  job: CoordinatorJob;
  budget: JobBudget;
  parallel_allowed: number;
  degraded_mode: string;
  degraded_reason?: string;
  approval_required: boolean;
  est_usd_low: number;
  est_usd_high: number;
  host_capacity: HostCapacitySnapshot;
}

// ── External Agents types ───────────────────────────────────────────────────

export type AgentType = 'claude-code' | 'cursor-cli';

export type PermissionMode =
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default';

export type AgentStatus =
  | 'creating'
  | 'running'
  | 'awaiting_merge'
  | 'merged'
  | 'discarded'
  | 'cancelled'
  | 'failed';

export interface NormalizedEvent {
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error' | 'stderr';
  at: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  meta?: Record<string, unknown>;
}

export interface ExternalAgentSession {
  session_id: string;
  agent_type: AgentType;
  goal: string;
  project_path: string;
  worktree_id: string;
  worktree_path: string;
  branch: string;
  base_branch?: string;
  permission_mode: PermissionMode;
  mcp_enabled: boolean;
  profile_id?: string;
  role_id?: string;
  model?: string;
  system_prompt_preamble?: string;
  status: AgentStatus;
  pid?: number;
  exit_code?: number | null;
  transcript_path: string;
  mcp_config_path?: string;
  child_session_id?: string;
  diff?: string;
  final_message?: string;
  cost_usd?: number;
  tokens?: { input: number; output: number };
  turn_count: number;
  created_at: string;
  updated_at: string;
  error?: string;
  parent_job_id?: string;
  task_id?: string;
}

export interface CreateAgentSessionRequest {
  goal: string;
  agent_type?: AgentType;
  permission_mode?: PermissionMode;
  mcp_enabled?: boolean;
  project_path?: string;
  base_branch?: string;
  worktree_name?: string;
  resolved_profile?: {
    profile_id: string;
    agent_type: AgentType;
    permission_mode: PermissionMode;
    mcp_enabled: boolean;
    model?: string;
    system_prompt_preamble?: string;
    extra_args: string[];
  };
}

// ── Yggdrasil / Runner types ────────────────────────────────────────────────

export interface RunnerInfo {
  runnerId: string;
  name: string;
  endpoint: string;
  status: 'online' | 'offline' | 'starting';
  capabilities: string[];
  systemResources: {
    cpu: { percent: number };
    memory: { total: number; free: number; available: number; percent: number };
  };
  tasks: Array<{ taskId: string; goal: string; status: string; runnerId: string }>;
  lastHeartbeat: string;
  version: string;
}

export interface AdmissionState {
  open: boolean;
  available_slots: number;
  total_slots: number;
  reason?: string;
}

export interface DispatchRequest {
  runner_id: string;
  task_id: string;
  goal: string;
  metadata?: Record<string, unknown>;
  capabilities?: string[];
  max_concurrent?: number;
}

// ── Dev-agent proxy types ───────────────────────────────────────────────────

export interface DevAgentExecuteRequest {
  tool: string;
  action: string;
  text?: string;
  x?: number;
  y?: number;
  keys?: string[] | string;
  scale?: number;
  screen_region?: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
}

export interface DevAgentExecuteResponse {
  success?: boolean;
  output?: string;
  screenshot?: string;
  screens?: Array<{ index: number; width: number; height: number; x: number; y: number; name?: string }>;
  bounds?: { x: number; y: number; width: number; height: number };
  elements?: Array<{ text: string; x: number; y: number; width: number; height: number }>;
  [key: string]: unknown;
}
