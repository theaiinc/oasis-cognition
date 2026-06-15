export type AgentType = 'claude-code' | 'cursor-cli' | 'opencode';

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
  input?: any;
  output?: any;
  meta?: Record<string, any>;
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

export interface CreateAgentSessionDto {
  goal: string;
  agent_type?: AgentType;
  permission_mode?: PermissionMode;
  mcp_enabled?: boolean;
  project_path?: string;
  base_branch?: string;
  worktree_name?: string;
  /** Pre-resolved by caller (api-gateway) from agent profiles + project roles. */
  resolved_profile?: {
    profile_id: string;
    agent_type: AgentType;
    permission_mode: PermissionMode;
    mcp_enabled: boolean;
    model?: string;
    system_prompt_preamble?: string;
    extra_args: string[];
  };
  resolved_role?: {
    role_id: string;
    description?: string;
  };
}

export interface AgentFollowUpDto {
  message: string;
}

export interface AgentAdapter {
  type: AgentType;
  buildInitialCommand(
    session: ExternalAgentSession,
    mcpConfigPath?: string,
    extraArgs?: string[],
  ): AgentCommand;
  buildFollowUpCommand(
    session: ExternalAgentSession,
    message: string,
    mcpConfigPath?: string,
    extraArgs?: string[],
  ): AgentCommand;
  parseStreamEvent(line: string): NormalizedEvent | null;
  summarise(events: NormalizedEvent[]): Partial<Pick<ExternalAgentSession,
    'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>>;
}

export interface AgentCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}
