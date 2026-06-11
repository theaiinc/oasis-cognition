/**
 * External-agent types shared across controller, service, and adapters.
 *
 * An "external agent" is a third-party coding/action agent (e.g. the Claude
 * Code CLI) that Oasis spawns as a subprocess in a git worktree and surfaces
 * back to the user with plan-approval + diff-review semantics.
 */

/** Supported third-party agent types. */
export type AgentType = 'claude-code' | 'cursor-cli';

/** Permission mode passed through to the underlying agent CLI. */
export type PermissionMode =
  | 'plan'              // read/propose only
  | 'acceptEdits'       // auto-edit inside the worktree (our default)
  | 'bypassPermissions' // skip all permission prompts
  | 'default';          // ask for every write (interactive)

/** Lifecycle state of an external-agent session. */
export type AgentStatus =
  | 'creating'        // worktree + config being set up
  | 'running'         // subprocess alive
  | 'awaiting_merge'  // child exited cleanly, diff ready for review
  | 'merged'          // worktree changes applied to base branch
  | 'discarded'       // worktree thrown away
  | 'cancelled'       // user killed the child mid-run
  | 'failed';         // non-zero exit or spawn/setup error

/** One normalised event parsed from the adapter's stream-json output. */
export interface NormalizedEvent {
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error' | 'stderr';
  at: string;               // ISO timestamp
  text?: string;
  tool?: string;
  input?: any;
  output?: any;
  meta?: Record<string, any>;
}

/** In-memory + on-disk session record. */
export interface ExternalAgentSession {
  session_id: string;            // Oasis-side UUID (also passed as --session-id when the child honors it)
  agent_type: AgentType;
  goal: string;
  project_path: string;          // base directory (repo root)
  worktree_id: string;           // dev-agent worktree handle
  worktree_path: string;         // absolute path to the worktree
  branch: string;                // branch name the worktree is on
  base_branch?: string;          // branch to merge back into (if known)
  permission_mode: PermissionMode;
  mcp_enabled: boolean;
  /** The agent profile this session was spawned from, if any. Snapshot only —
   *  deleting the profile later does not retroactively change the session. */
  profile_id?: string;
  /** The project role this session was spawned under, if any. Snapshot. */
  role_id?: string;
  /** The model the child CLI was invoked with (via `--model`). */
  model?: string;
  /** The system-prompt preamble composed from role.description + profile
   *  preamble, passed to the child. Captured here for observability. */
  system_prompt_preamble?: string;
  status: AgentStatus;
  pid?: number;
  exit_code?: number | null;
  transcript_path: string;       // ~/.oasis/agent-sessions/<sid>/transcript.ndjson
  mcp_config_path?: string;      // ~/.oasis/agent-sessions/<sid>/mcp.json, if mcp_enabled
  /** The session/chat id the child CLI uses for --resume. For claude-code we
   *  set it ourselves to equal session_id; for cursor-cli we read it from the
   *  first system event and store it here. */
  child_session_id?: string;
  diff?: string;                 // cached diff snapshot (populated on completion / on demand)
  final_message?: string;        // last assistant text
  cost_usd?: number;
  tokens?: { input: number; output: number };
  turn_count: number;            // how many `-p` invocations so far (incl. follow-ups)
  created_at: string;
  updated_at: string;
  error?: string;
  /** When this child was spawned by a coordinator job, the parent job id. */
  parent_job_id?: string;
  /** The task id within the parent job that this child fulfils. */
  task_id?: string;
}

/** Serialisable shape of what a caller is allowed to set when creating a session. */
export interface CreateAgentSessionDto {
  goal: string;
  /** Preferred: spawn via a saved profile + optional project role. The
   *  role's description becomes a system-prompt preamble, and the profile
   *  supplies agent_type / model / permission_mode / mcp_enabled / extra_args. */
  profile_id?: string;
  role_id?: string;
  /** Legacy direct path: picked when profile_id is absent. */
  agent_type?: AgentType;
  permission_mode?: PermissionMode;  // default 'acceptEdits'
  mcp_enabled?: boolean;             // default true
  project_path?: string;
  base_branch?: string;
  worktree_name?: string;
}

/** Body for follow-up messages. */
export interface AgentFollowUpDto {
  message: string;
}

/** Adapter contract implemented per-agent-type. */
export interface AgentAdapter {
  type: AgentType;
  /** Build the spawn command for the initial run (`-p <goal>`). */
  buildInitialCommand(
    session: ExternalAgentSession,
    mcpConfigPath?: string,
    extraArgs?: string[],
  ): AgentCommand;
  /** Build the spawn command for a follow-up turn (`--resume <sid> -p <msg>`). */
  buildFollowUpCommand(
    session: ExternalAgentSession,
    message: string,
    mcpConfigPath?: string,
    extraArgs?: string[],
  ): AgentCommand;
  /** Parse one NDJSON line from the child's stdout into a normalised event. */
  parseStreamEvent(line: string): NormalizedEvent | null;
  /** Called when the child exits; derive final message + cost + tokens +
   *  (optionally) the child-side session/chat id that `--resume` should use. */
  summarise(events: NormalizedEvent[]): Partial<Pick<ExternalAgentSession,
    'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>>;
}

/** What an adapter returns from buildXxxCommand — everything dev-agent needs to spawn. */
export interface AgentCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}
