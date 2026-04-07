export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant' | 'system';
  confidence?: string;
  timestamp: Date;
  isTranscript?: boolean;
  isQueued?: boolean;
  replyToMessageId?: string;
  replyToPreview?: string;
}

export interface TimelineEvent {
  event_id?: string;
  event_type: string;
  session_id?: string;
  trace_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ProjectConfig {
  configured: boolean;
  project_path?: string;
  project_name?: string;
  project_type?: 'local' | 'git';
  git_url?: string;
  last_indexed?: string;
  context_summary?: string;
  tech_stack?: string[];
  frameworks?: string[];
}

/** Per-project settings that override global .env defaults. */
export interface ProjectSettings {
  // Code indexing
  project_path?: string;
  project_type?: 'local' | 'git';
  git_url?: string;
  last_indexed?: string;
  context_summary?: string;
  tech_stack?: string[];
  frameworks?: string[];
  // LLM overrides
  llm_provider?: string;
  llm_model?: string;
  llm_max_tokens?: number;
  openai_api_key?: string;
  openai_base_url?: string;
  anthropic_api_key?: string;
  ollama_host?: string;
  response_llm_provider?: string;
  response_llm_model?: string;
  tool_plan_llm_provider?: string;
  tool_plan_llm_model?: string;
  vision_llm_model?: string;
  context_window?: number;
  context_output_reserve?: number;
  embedding_model?: string;
  log_level?: string;
}

export interface GraphData {
  graph: Record<string, unknown>;
  timestamp: string;
  reasoning_trace?: string[];
  confidence?: number;
  conclusion?: string;
}

export interface RulesGraphData {
  nodes: Array<{ id: string; condition?: string; conclusion?: string; confidence?: number; created_at?: string }>;
  edges: Array<{ source: string; target: string; edge_type?: string; shared_concepts?: string[] }>;
}

export interface CodeGraphNode {
  id: string;
  label: string;
  node_type: string;   // 'CodeFile' | 'function' | 'class' | 'interface' | ...
  file_path?: string;
  line?: number;
}

export interface CodeGraphEdge {
  source: string;
  target: string;
  rel: string;         // 'CONTAINS' | 'IMPORTS' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS'
}

export interface CodeGraphData {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  stats?: { files: number; symbols: number };
}

/* ── Computer-Use Agent ────────────────────────────────────────────────── */

export type CuStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
export type CuSessionStatus =
  | 'planning' | 'awaiting_approval' | 'executing' | 'paused'
  | 'completed' | 'failed' | 'cancelled';

export interface CuSubStep {
  index: number;
  description: string;
  action: string;
  target?: string;
  status: CuStepStatus;
  output?: string;
  screenshot?: string;
}

export interface CuPlanStep {
  index: number;
  description: string;
  action: string;
  target?: string;
  status: CuStepStatus;
  sub_steps?: CuSubStep[];
  retry_count?: number;
  screenshot?: string;
  output?: string;
  block_reason?: string;
  started_at?: string;
  completed_at?: string;
}

export interface CuPolicy {
  domain_whitelist: string[];
  domain_blacklist: string[];
  action_whitelist: string[];
  action_blacklist: string[];
  max_steps: number;
  max_duration_seconds: number;
  require_step_approval: boolean;
}

export interface CuSession {
  session_id: string;
  goal: string;
  status: CuSessionStatus;
  policy: CuPolicy;
  plan: CuPlanStep[];
  current_step: number;
  live_screenshot?: string;
  created_at: string;
  updated_at: string;
  error?: string;
  visionGranted?: boolean;
}

/* ── Context Budget / Token Usage ─────────────────────────────────────── */

export interface ContextBudget {
  context_window: number;
  input_budget: number;
  input_used: number;
  input_remaining: number;
  breakdown: Record<string, number>;
  iteration?: number;
}

export interface GraphPanelProps {
  graphsBySessionId: Record<string, GraphData>;
  currentSessionId: string;
  memoryRules: Array<{ rule_id?: string; condition?: string; conclusion?: string; confidence?: number }>;
  rulesGraph: RulesGraphData | null;
  messages: Message[];
  onClose: () => void;
  /** Refetch rules/graph (e.g. when switching to Logic tab). */
  onRefreshRules?: () => void;
  /** From memory-service: `neo4j` vs `fallback` (empty rules if Neo4j had rules but service is on fallback). */
  rulesStorageBackend?: string | null;
  codeGraph?: CodeGraphData | null;
  onLoadCodeGraph?: () => void;
}
