/**
 * Mission = a recurring goal Oasis owns on your behalf. The unifying abstraction
 * that turns the box of primitives (sessions, scheduled-tasks, agent profiles,
 * connectors, workflows) into a "the assistant just does it for me" experience.
 *
 * Each mission has:
 *   - a goal (human-readable: "watch my Zalo and draft replies")
 *   - a prompt (what to send the agent on every tick)
 *   - a cron schedule
 *   - a session_id where the agent runs (so its chat history accumulates per mission)
 *   - an optional notify_session_id where digest cards land in the user's main chat
 *   - optional role/profile/connector bindings
 */

export type MissionState = 'idle' | 'running' | 'paused' | 'failed';

export interface Mission {
  mission_id: string;
  project_id?: string;
  goal: string;
  /** What gets sent to the agent on each tick. Often identical to goal but may include extra instructions. */
  prompt: string;
  /** Standard 5-field cron expression (e.g. "*\/10 * * * *" for every 10 min). */
  schedule: string;
  enabled: boolean;
  /**
   * The session_id where the mission's tick interactions execute. Each mission
   * owns its own session so its chat history is isolated from the user's main thread.
   */
  session_id: string;
  /**
   * Where digest cards should surface (typically the chat session that created the mission).
   * `null` means "do not surface a card; only emit timeline events on the mission's own session".
   */
  notify_session_id: string | null;
  role_id?: string;
  profile_id?: string;
  /** Reserved for Phase 3 — when set, the mission's tick can use a connector's tools (Gmail, Zalo, etc.). */
  connector_id?: string;
  state: MissionState;
  last_run_at?: string;
  next_run_at?: string;
  last_result?: string;
  last_error?: string;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateMissionDto {
  project_id?: string;
  goal: string;
  prompt?: string;
  schedule: string;
  notify_session_id?: string | null;
  role_id?: string;
  profile_id?: string;
  connector_id?: string;
  enabled?: boolean;
}

export interface UpdateMissionDto {
  project_id?: string;
  goal?: string;
  prompt?: string;
  schedule?: string;
  notify_session_id?: string | null;
  role_id?: string;
  profile_id?: string;
  connector_id?: string;
  enabled?: boolean;
}
