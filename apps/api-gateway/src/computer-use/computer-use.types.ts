/**
 * Computer-Use Agent — types.
 *
 * The Computer-Use agent operates ONLY via approved plans.
 * It cannot be invoked directly; every action must belong to an active session
 * with a user-approved plan.  Whitelist / blacklist rules gate every step.
 */

/* ── Security Policy ──────────────────────────────────────────────────── */

export interface ComputerUsePolicy {
  /** Domains (glob patterns) the agent is ALLOWED to visit.  Empty = allow all except blacklist. */
  domain_whitelist: string[];
  /** Domains (glob patterns) the agent MUST NEVER visit.  Checked AFTER whitelist. */
  domain_blacklist: string[];
  /** Browser actions the agent is allowed to perform (e.g. 'navigate','click','type','screenshot'). Empty = allow all except blacklisted. */
  action_whitelist: string[];
  /** Browser actions the agent must NEVER perform. */
  action_blacklist: string[];
  /** Maximum total steps in a single session (hard cap). */
  max_steps: number;
  /** Maximum seconds before the session auto-terminates. */
  max_duration_seconds: number;
  /** Require user confirmation before each step (step-by-step mode). */
  require_step_approval: boolean;
}

export const DEFAULT_POLICY: ComputerUsePolicy = {
  domain_whitelist: [],               // empty = allow all (minus blacklist)
  domain_blacklist: [
    '*.bank.*', '*.gov.*',            // banking / government
    'accounts.google.com',            // OAuth / credentials
    'login.*', 'signin.*', 'auth.*',  // generic auth pages
    'localhost:*',                     // prevent self-access
    '127.0.0.1:*',
  ],
  action_whitelist: [],               // empty = allow all (minus blacklist)
  action_blacklist: [
    'file_upload',                    // no uploading user files
  ],
  max_steps: 50,
  max_duration_seconds: 600, // 10 min
  require_step_approval: false,
};

/* ── Plan & Steps ─────────────────────────────────────────────────────── */

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';

/** A low-level atomic action (click, type, navigate, etc.) within a high-level step. */
export interface SubStep {
  index: number;
  description: string;
  action: string;
  target?: string;
  status: StepStatus;
  output?: string;
  screenshot?: string;
}

/**
 * A high-level plan step (e.g., "Navigate to GitHub", "Find repositories").
 * Each step is broken into sub-steps at execution time based on the current screen.
 * Sub-steps can be retried/revised without affecting the overall plan.
 */
export interface PlanStep {
  index: number;
  description: string;
  /** The high-level intent (e.g. "navigate_to", "find_element", "interact", "verify"). */
  action: string;
  /** Target URL or element description. */
  target?: string;
  status: StepStatus;
  /** Atomic sub-steps generated at execution time. */
  sub_steps?: SubStep[];
  /** How many times this step has been retried. */
  retry_count?: number;
  /** Screenshot base64 after completion (trimmed for transport). */
  screenshot?: string;
  /** Text output / extracted data. */
  output?: string;
  /** If blocked, the reason. */
  block_reason?: string;
  started_at?: string;
  completed_at?: string;
}

export type SessionStatus =
  | 'planning'          // LLM is drafting the plan
  | 'awaiting_approval' // Plan ready, waiting for user OK
  | 'executing'         // Steps are running
  | 'paused'            // User paused or step-approval mode
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ComputerUseSession {
  session_id: string;
  goal: string;
  status: SessionStatus;
  policy: ComputerUsePolicy;
  plan: PlanStep[];
  current_step: number;
  /** Screenshot of the current browser state. */
  live_screenshot?: string;
  created_at: string;
  updated_at: string;
  error?: string;
}

/* ── API DTOs ─────────────────────────────────────────────────────────── */

/** Info about what the user is sharing via getDisplayMedia. */
export interface ShareInfo {
  /** "monitor", "window", "browser", or "unknown". */
  displaySurface: string;
  /** Track label — usually contains window/app name (e.g. "Google Chrome - GitHub"). */
  label: string;
  /** Original capture resolution (before downscale). */
  sourceWidth: number;
  sourceHeight: number;
}

/** Capture target for native screen capture via dev-agent (pyautogui). */
export type CaptureTargetMode = 'full_screen' | 'screen' | 'window' | 'app';

export interface CaptureTarget {
  /** What to capture: full screen, specific window, or specific app. */
  mode: CaptureTargetMode;
  /** App or window name/title — required when mode is 'window' or 'app'. */
  target?: string;
}

export interface CreateSessionDto {
  goal: string;
  /** Override default policy. */
  policy?: Partial<ComputerUsePolicy>;
  /** Base64-encoded screen image from active screen sharing (JPEG). */
  screen_image?: string;
  /** Metadata about the shared display surface (legacy browser sharing). */
  share_info?: ShareInfo;
  /** Native capture target — defines what pyautogui screenshots will capture. */
  capture_target?: CaptureTarget;
}

export interface ApproveSessionDto {
  session_id: string;
}

export interface StepApprovalDto {
  session_id: string;
  step_index: number;
  approved: boolean;
}

export interface UpdatePolicyDto {
  session_id: string;
  policy: Partial<ComputerUsePolicy>;
}
