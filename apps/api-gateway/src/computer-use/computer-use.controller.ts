/**
 * Computer-Use Agent Controller.
 *
 * The agent operates ONLY through user-approved plans:
 *   1. User submits a goal  →  LLM drafts a plan
 *   2. User reviews & approves the plan (+ grants vision permission)
 *   3. Agent executes steps autonomously via computer_action (real host control)
 *   4. User can pause, resume, cancel, or step-approve at any time
 *
 * There is NO direct tool invocation endpoint — everything flows through plans.
 * Execution happens entirely server-side — NOT through the chat pipeline.
 */

import {
  Controller, Post, Get, Delete, Patch, Body, Param,
  Logger, HttpException, HttpStatus,
} from '@nestjs/common';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

import type {
  ComputerUseSession,
  CreateSessionDto,
  ApproveSessionDto,
  StepApprovalDto,
  UpdatePolicyDto,
  PlanStep,
} from './computer-use.types';
import { DEFAULT_POLICY } from './computer-use.types';
import { evaluateStepPolicy, validateSessionForExecution } from './computer-use.guard';

const RESPONSE_URL = process.env.RESPONSE_URL || 'http://localhost:8005';
const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const UI_PARSER_URL = process.env.UI_PARSER_URL || 'http://localhost:8011';
const LLM_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 30_000;

/* ── In-memory session store (single-instance; sufficient for dev) ───── */
const sessions = new Map<string, ComputerUseSession & { visionGranted: boolean }>();

/**
 * Detect the HOST platform (where pyautogui runs) at startup.
 * The API gateway runs in Docker (linux), but the dev-agent runs on the host (macOS/Windows/Linux).
 * Hotkeys must match the HOST platform, not the container.
 */
let HOST_PLATFORM: 'darwin' | 'linux' | 'windows' = 'darwin'; // default to macOS
(async () => {
  try {
    const res = await axios.get(`${DEV_AGENT_URL}/health`, { timeout: 5000 });
    const p = res.data?.platform || '';
    if (p === 'darwin' || p === 'linux' || p === 'windows') HOST_PLATFORM = p;
  } catch { /* keep default */ }
})();

/** Get the modifier key for the host platform (Command on macOS, Ctrl elsewhere). */
function hostModifier(): string {
  return HOST_PLATFORM === 'darwin' ? 'command' : 'ctrl';
}

/**
 * Extract the app/browser name from a screen-share track label.
 * Common formats: "Page Title - Google Chrome", "Page Title — Mozilla Firefox", "App Name"
 * Returns the last segment after a dash separator, or the full label if no separator found.
 */
function getAppNameFromLabel(label: string): string {
  if (!label) return '';
  for (const sep of [' - ', ' — ', ' – ']) {
    const parts = label.split(sep);
    if (parts.length > 1) return parts[parts.length - 1].trim();
  }
  return label;
}

@Controller('computer-use')
export class ComputerUseController {
  private readonly logger = new Logger(ComputerUseController.name);

  /* ──────────────────────────── Sessions ──────────────────────────────── */

  /** List all sessions (newest first). */
  @Get('sessions')
  listSessions() {
    return [...sessions.values()]
      .map(({ live_screenshot, ...rest }) => rest) // strip large screenshots from list
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Get the most recent non-terminal session (for panel reconnection after tab switch). */
  @Get('sessions/active')
  getActiveSession() {
    const active = [...sessions.values()]
      .filter(s => !['completed', 'failed', 'cancelled'].includes(s.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (active.length === 0) return { session: null };
    // Strip heavy screenshot for the list response
    const { live_screenshot, ...rest } = active[0];
    return { session: rest };
  }

  /** Get a single session (includes live screenshot). */
  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    const s = sessions.get(id);
    if (!s) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    return s;
  }

  /* ──────────────────────────── Create & Plan ─────────────────────────── */

  /**
   * Create a new computer-use session.
   * The LLM will draft a plan for the goal; the session starts in `planning` state.
   * Vision is NOT granted yet — user must explicitly approve.
   */
  @Post('sessions')
  async createSession(@Body() dto: CreateSessionDto) {
    if (!dto.goal?.trim()) {
      throw new HttpException('Goal is required', HttpStatus.BAD_REQUEST);
    }

    const sessionId = `cu-${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();
    const policy = { ...DEFAULT_POLICY, ...dto.policy };

    const session: ComputerUseSession & { visionGranted: boolean } = {
      session_id: sessionId,
      goal: dto.goal.trim(),
      status: 'planning',
      policy,
      plan: [],
      current_step: 0,
      created_at: now,
      updated_at: now,
      visionGranted: false, // MUST be explicitly granted
    };
    // Store screen image and share metadata on session
    if (dto.screen_image) {
      (session as any)._screen_image = dto.screen_image;
      session.live_screenshot = dto.screen_image;
      // Mark the creation frame with a timestamp so getScreenImage() treats it as fresh
      (session as any)._screen_frame_at = Date.now();
    }
    if (dto.share_info) {
      (session as any)._share_info = dto.share_info;
      this.logger.log(`Share info: surface=${dto.share_info.displaySurface}, label="${dto.share_info.label}", ${dto.share_info.sourceWidth}x${dto.share_info.sourceHeight}`);
    }
    if (dto.capture_target) {
      (session as any)._capture_target = dto.capture_target;
      this.logger.log(`Capture target: mode=${dto.capture_target.mode}, target="${dto.capture_target.target || 'all'}"`);
    }

    sessions.set(sessionId, session);

    // For screen mode, fetch the screen geometry AFTER session is stored in the map
    // Await it so geometry is ready before plan generation starts
    if (dto.capture_target?.mode === 'screen' && dto.capture_target.target) {
      await this.fetchScreenGeometry(sessionId, parseInt(dto.capture_target.target, 10)).catch((err) => {
        this.logger.warn(`Failed to fetch screen geometry: ${err.message}`);
      });
    }
    this.logger.log(`Created computer-use session: ${sessionId} — "${dto.goal}" (screen: ${dto.screen_image ? 'yes' : 'no'})`);

    // Ask LLM to draft a plan (non-blocking; client polls status)
    this.draftPlan(sessionId, dto.goal, policy, dto.screen_image).catch((err) => {
      if (session.status !== 'failed') {
        const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
        this.logger.error(`Plan generation failed for ${sessionId}: ${detail}`);
        session.status = 'failed';
        session.error = `Plan generation failed: ${detail}`;
        session.updated_at = new Date().toISOString();
      }
    });

    return { session_id: sessionId, status: 'planning' };
  }

  /**
   * Approve the plan AND grant vision permission.
   * This is the ONLY way to grant vision — it cannot be done retroactively.
   */
  @Post('sessions/:id/approve')
  async approveSession(
    @Param('id') id: string,
    @Body() dto: ApproveSessionDto & { grant_vision: boolean },
  ) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);

    if (session.status !== 'awaiting_approval') {
      throw new HttpException(
        `Cannot approve: session is "${session.status}", expected "awaiting_approval"`,
        HttpStatus.CONFLICT,
      );
    }

    if (!dto.grant_vision) {
      throw new HttpException(
        'You must explicitly grant vision permission (grant_vision: true) to approve this session. ' +
        'The computer-use agent requires screen vision to execute browser tasks.',
        HttpStatus.BAD_REQUEST,
      );
    }

    session.visionGranted = true;
    session.status = 'executing';
    session.updated_at = new Date().toISOString();
    this.logger.log(`Session ${id} approved with vision grant — starting execution`);

    // Begin execution (non-blocking)
    this.executeSteps(id).catch((err) => {
      this.logger.error(`Execution failed for ${id}: ${err.message}`);
      session.status = 'failed';
      session.error = err.message;
      session.updated_at = new Date().toISOString();
    });

    return { session_id: id, status: 'executing', vision_granted: true };
  }

  /** Approve or reject a single step (when require_step_approval is on). */
  @Post('sessions/:id/step-approve')
  async stepApprove(@Param('id') id: string, @Body() dto: StepApprovalDto) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);

    if (session.status !== 'paused') {
      throw new HttpException('Session is not paused for step approval', HttpStatus.CONFLICT);
    }

    const step = session.plan[dto.step_index];
    if (!step) throw new HttpException('Invalid step index', HttpStatus.BAD_REQUEST);

    if (dto.approved) {
      step.status = 'pending';
      session.status = 'executing';
      session.updated_at = new Date().toISOString();
      this.executeSteps(id).catch(() => {});
      return { status: 'executing', step_index: dto.step_index };
    } else {
      step.status = 'skipped';
      step.block_reason = 'User rejected this step';
      session.current_step++;
      session.updated_at = new Date().toISOString();

      // If more steps, pause for next approval
      if (session.current_step < session.plan.length) {
        return { status: 'paused', next_step: session.current_step };
      }
      session.status = 'completed';
      return { status: 'completed' };
    }
  }

  /* ──────────────────────────── Control ───────────────────────────────── */

  @Post('sessions/:id/pause')
  pauseSession(@Param('id') id: string) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (session.status !== 'executing') {
      throw new HttpException(`Cannot pause: status is "${session.status}"`, HttpStatus.CONFLICT);
    }
    session.status = 'paused';
    session.updated_at = new Date().toISOString();
    return { status: 'paused' };
  }

  @Post('sessions/:id/resume')
  async resumeSession(@Param('id') id: string) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (session.status !== 'paused') {
      throw new HttpException(`Cannot resume: status is "${session.status}"`, HttpStatus.CONFLICT);
    }
    session.status = 'executing';
    session.error = undefined; // clear any "screen sharing stopped" error
    session.updated_at = new Date().toISOString();
    this.executeSteps(id).catch(() => {});
    return { status: 'executing' };
  }

  /** Accept steering feedback mid-execution (no pause required). */
  @Post('sessions/:id/feedback')
  sendFeedback(@Param('id') id: string, @Body() body: { message: string }) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (!body.message?.trim()) throw new HttpException('Message required', HttpStatus.BAD_REQUEST);

    // Append to feedback queue — consumed by next sub-step generation
    const queue: string[] = (session as any)._feedback_queue || [];
    queue.push(body.message.trim());
    (session as any)._feedback_queue = queue;

    this.logger.log(`Feedback for ${id}: "${body.message.trim()}"`);
    return { ok: true, queued: queue.length };
  }

  @Delete('sessions/:id')
  async cancelSession(@Param('id') id: string) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    session.status = 'cancelled';
    session.visionGranted = false; // revoke vision on cancel
    session.updated_at = new Date().toISOString();
    return { status: 'cancelled' };
  }

  /* ──────────────────────────── Policy ────────────────────────────────── */

  @Patch('sessions/:id/policy')
  updatePolicy(@Param('id') id: string, @Body() dto: UpdatePolicyDto) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    session.policy = { ...session.policy, ...dto.policy };
    session.updated_at = new Date().toISOString();
    this.logger.log(`Policy updated for ${id}`);
    return { policy: session.policy };
  }

  @Get('default-policy')
  getDefaultPolicy() {
    return DEFAULT_POLICY;
  }

  /** Receive a screen-share frame from the UI (called periodically while sharing). */
  @Post('sessions/:id/screen-frame')
  async pushScreenFrame(@Param('id') id: string, @Body() body: { image: string }) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (body.image) {
      session.live_screenshot = body.image;
      (session as any)._screen_frame_at = Date.now();

    }
    return { ok: true };
  }


  /**
   * Receive detection + OCR results for a session's current screen.
   * Called by an external detection pipeline (YOLO + OCR) after processing a screen frame.
   * The UI parser service uses these to resolve click coordinates without LLM calls.
   */
  @Post('sessions/:id/ui-detections')
  async pushUIDetections(
    @Param('id') id: string,
    @Body() body: {
      detections?: Array<{ bbox: number[]; label: string; confidence: number }>;
      ocr?: Array<{ text: string; bbox: number[] }>;
    },
  ) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);

    if (body.detections) (session as any)._ui_detections = body.detections;
    if (body.ocr) (session as any)._ui_ocr = body.ocr;

    // Eagerly update the parsed UI cache
    const screenImage = await this.getScreenImage(id);
    if (screenImage) {
      await this.updateUIParseCache(id, screenImage);
    }

    this.logger.log(`UI detections updated for ${id}: ${body.detections?.length || 0} detections, ${body.ocr?.length || 0} OCR`);
    return {
      ok: true,
      cached_components: (session as any)._ui_parse_cache?.length || 0,
    };
  }

  /* ──────────────────────────── Internal: Plan Generation ───────────── */

  /** Extract a JSON array from LLM text (handles fences, leading prose, etc.) */
  private extractJsonArray(text: string): string | null {
    const trimmed = (text || '').trim();
    if (trimmed.startsWith('[')) return trimmed;
    const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    if (fence) return fence[1];
    const arr = text.match(/\[[\s\S]*\]/);
    return arr ? arr[0] : null;
  }

  /** Build a description of what the user is currently sharing, for the planner. */
  private getShareContext(sessionId: string): string {
    const session = sessions.get(sessionId);
    const shareInfo = (session as any)?._share_info as {
      displaySurface: string; label: string; sourceWidth: number; sourceHeight: number;
    } | undefined;
    if (!shareInfo) return 'No screen sharing info available.';
    const surface = shareInfo.displaySurface;
    const label = shareInfo.label || '(unknown)';
    if (surface === 'monitor') {
      return `User is sharing their FULL SCREEN (monitor). You may interact with any visible application. The display is "${label}" (${shareInfo.sourceWidth}×${shareInfo.sourceHeight}).`;
    }
    return `User is sharing a SINGLE WINDOW: "${label}" (${surface}, ${shareInfo.sourceWidth}×${shareInfo.sourceHeight}). ` +
      `You MUST only interact with elements INSIDE that window. Do NOT navigate to other apps or windows. ` +
      `The window title "${label}" tells you what application and page is currently open.`;
  }

  /**
   * Ask the LLM to draft a step-by-step plan for the goal.
   * Sends the current screen-share image so the plan is grounded in reality.
   */
  private async draftPlan(
    sessionId: string,
    goal: string,
    policy: typeof DEFAULT_POLICY,
    screenImage?: string,
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    const hasScreen = !!screenImage;
    const shareCtx = this.getShareContext(sessionId);

    const systemPrompt =
      `You are a computer-use planner. You create SHORT, efficient step-by-step plans to control a real computer.\n\n` +
      `SHARED SCREEN CONTEXT:\n${shareCtx}\n\n` +
      `${hasScreen ? 'A screenshot of the current screen is attached. ANALYZE IT FIRST before planning:\n' +
        '1. What application/browser is currently open?\n' +
        '2. Is the user ALREADY logged in? (Look for profile avatars, usernames, dashboard elements)\n' +
        '3. What page/URL is currently visible?\n' +
        '4. What is the current state? (e.g., already on GitHub homepage, already on repos page)\n' +
        'YOUR PLAN MUST START FROM THE CURRENT STATE. Do NOT include steps for things already done.\n\n' :
        'No screenshot available. Start with a "read_screen" step to observe the screen.\n\n'}` +
      `OUTPUT FORMAT: One step per line using this format (NO JSON, NO markdown):\n` +
      `STEP: <action> | <target> | <description>\n\n` +
      `ACTIONS:\n` +
      `- navigate | <full URL> | description — goes to a URL directly\n` +
      `- click | <visual element description> | description — clicks a visible element\n` +
      `- type | <text to type> | description — types text into the focused field\n` +
      `- scroll | up/down | description — scrolls the page\n` +
      `- read_screen | | description — captures screenshot AND extracts all visible text\n` +
      `- key_press | <key or combo e.g. enter, ${hostModifier()}+l> | description\n` +
      `- wait | <seconds> | description — waits (only if page needs time to load)\n\n` +
      `EFFICIENCY RULES (these are critical):\n` +
      `1. Generate 3-6 steps. Fewer is better. Every step costs time.\n` +
      `2. NEVER use "screenshot" as a standalone step — "read_screen" already captures the screen AND extracts text. Use read_screen instead.\n` +
      `3. NEVER put "wait" after "navigate" — the navigate action already waits for page load.\n` +
      `4. NEVER put "screenshot" before "read_screen" — read_screen already takes a screenshot.\n` +
      `5. ALWAYS prefer "navigate" with a direct URL over "click" for reaching pages. Direct URLs are 10x more reliable.\n` +
      `6. For GitHub: use direct URLs like https://github.com/orgs/ORGNAME/repositories or https://github.com/USERNAME?tab=repositories\n` +
      `7. One "read_screen" is enough per page — do NOT repeat read_screen unless you scrolled.\n` +
      `8. Only scroll if you have evidence the content continues below the fold. Don't preemptively scroll.\n` +
      `9. Plans execute LINEARLY — NO conditional logic.\n\n` +
      `OTHER RULES:\n` +
      `- NEVER include login/signup/authentication steps. Assume the user is already logged in.\n` +
      `- NEVER use placeholders like USERNAME or USER in URLs.\n` +
      `  When you need an unknown value, use this discovery pattern:\n` +
      `  STEP: read_screen | | Read screen to discover username\n` +
      `  STEP: navigate | https://github.com/__DISCOVERED_USERNAME__?tab=repositories | Go to repos page\n` +
      `  The execution engine replaces __DISCOVERED_*__ tokens with values from read_screen.\n` +
      `- End with "read_screen" to capture the final result.\n` +
      `- NEVER interact with localhost:3000 (Oasis UI).\n\n` +
      `EXAMPLE — "list repos for org theaiinc":\n` +
      `STEP: navigate | https://github.com/orgs/theaiinc/repositories | Go directly to org repos page\n` +
      `STEP: read_screen | | Read all visible repository names\n` +
      `STEP: scroll | down | Scroll for more repos\n` +
      `STEP: read_screen | | Read additional repositories\n\n` +
      `EXAMPLE — "list all my github repos" (username unknown):\n` +
      `STEP: navigate | https://github.com | Go to GitHub\n` +
      `STEP: read_screen | | Read screen to find logged-in username\n` +
      `STEP: navigate | https://github.com/__DISCOVERED_USERNAME__?tab=repositories | Navigate to repos page\n` +
      `STEP: read_screen | | Read all visible repository names\n` +
      `STEP: scroll | down | Scroll for more repos\n` +
      `STEP: read_screen | | Read additional repositories\n\n` +
      `Blocked domains: ${policy.domain_blacklist.join(', ')}\n` +
      `Blocked actions: ${policy.action_blacklist.join(', ')}\n\n` +
      `Output ONLY STEP: lines. Nothing else.`;

    try {
      const chatPayload: Record<string, any> = {
        user_message: `Plan the steps to achieve this goal: ${goal}`,
        context: {
          system_override: systemPrompt,
          max_tokens: 2048,
          ...(hasScreen ? { screen_image: screenImage } : {}),
        },
      };
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, chatPayload, { timeout: LLM_TIMEOUT_MS });

      const text: string = res.data?.response_text || res.data?.response || res.data?.text || '';
      this.logger.log(`Plan LLM response (${text.length} chars): ${text.slice(0, 500)}`);

      // Parse flat STEP: lines (primary format)
      let rawSteps = this.parseStepLines(text);

      // Fallback: try JSON extraction if the LLM used JSON anyway
      if (rawSteps.length === 0) {
        this.logger.warn(`Flat-line parse found 0 steps, trying JSON fallback`);
        const jsonStr = this.extractJsonArray(text);
        if (jsonStr) {
          try {
            const jsonSteps = JSON.parse(jsonStr) as Array<{ description: string; action: string; target?: string }>;
            if (Array.isArray(jsonSteps) && jsonSteps.length > 0) {
              rawSteps = jsonSteps;
            }
          } catch { /* ignore */ }
        }
      }

      // Retry with minimal prompt if both formats failed
      if (rawSteps.length === 0) {
        this.logger.warn(`Plan parse failed for ${sessionId}, retrying`);
        try {
          const retryRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
            user_message:
              `Output ONLY steps to: ${goal}\n` +
              `Format: STEP: action | target | description\n` +
              `Valid actions: navigate, click, type, scroll, screenshot, read_screen, key_press, wait\n` +
              `Minimum 5 steps. Output ONLY STEP: lines:`,
            context: { system_override: 'Output ONLY STEP: lines. One per line. No prose, no JSON.', max_tokens: 2048 },
          }, { timeout: LLM_TIMEOUT_MS });
          const retryText = retryRes.data?.response_text || retryRes.data?.response || '';
          rawSteps = this.parseStepLines(retryText);
          // Still try JSON fallback
          if (rawSteps.length === 0) {
            const jsonStr = this.extractJsonArray(retryText);
            if (jsonStr) {
              const jsonSteps = JSON.parse(jsonStr);
              if (Array.isArray(jsonSteps) && jsonSteps.length > 0) rawSteps = jsonSteps;
            }
          }
        } catch (retryErr: any) {
          this.logger.warn(`Retry failed: ${retryErr.message}`);
        }
      }

      if (rawSteps.length === 0) {
        this.logger.warn(`All plan attempts failed for ${sessionId}, creating fallback plan`);
        session.plan = [
          { index: 0, description: 'Read current screen to observe state', action: 'read_screen', status: 'pending' as const },
          { index: 1, description: `Navigate to achieve: ${goal}`, action: 'read_screen', status: 'pending' as const },
        ];
        session.status = 'awaiting_approval';
        session.updated_at = new Date().toISOString();
        return;
      }

      // ── Post-process: remove problematic steps ──
      rawSteps = rawSteps.filter(s => {
        const desc = (s.description || '').toLowerCase();
        const tgt = (s.target || '').toLowerCase();
        if (s.action === 'navigate' && (tgt.includes('/login') || tgt.includes('/signin') || tgt.includes('/signup'))) {
          this.logger.warn(`Plan post-process: removed login step "${s.description}"`);
          return false;
        }
        if (desc.includes('log in') || desc.includes('sign in') || desc.includes('sign up')) {
          if (s.action === 'read_screen' || s.action === 'screenshot') return true;
          this.logger.warn(`Plan post-process: removed auth step "${s.description}"`);
          return false;
        }
        return true;
      });

      // Replace literal USERNAME/QUERY placeholders with __DISCOVERED_*__ tokens
      for (const s of rawSteps) {
        if (s.target) {
          s.target = s.target
            .replace(/\bUSERNAME\b/g, '__DISCOVERED_USERNAME__')
            .replace(/\bUSER\b/g, '__DISCOVERED_USERNAME__')
            .replace(/\bQUERY\b/g, '__DISCOVERED_QUERY__');
        }
      }

      // ── Post-process: strip redundant/wasteful steps ──
      rawSteps = this.optimizePlanSteps(rawSteps);

      session.plan = rawSteps.map((s, i) => ({
        index: i,
        description: s.description || `Step ${i + 1}`,
        action: s.action || 'screenshot',
        target: s.target,
        status: 'pending' as const,
      }));

      session.status = 'awaiting_approval';
      session.updated_at = new Date().toISOString();
      this.logger.log(`Plan ready for ${sessionId}: ${session.plan.length} steps`);
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data).slice(0, 500)
        : err.message || 'Unknown error';
      this.logger.error(`Plan generation error for ${sessionId}: ${detail}`);
      session.status = 'failed';
      session.error = `Plan generation failed: ${detail}`;
      session.updated_at = new Date().toISOString();
      throw err;
    }
  }

  /* ──────────────────────────── Internal: Execution ────────────────── */

  private static readonly MAX_ACTIONS_PER_STEP = 10;
  private static readonly MAX_PLAN_REVISIONS = 3;

  // ── CU-specific flat-line tool-plan format ──────────────────────────────────

  /**
   * System prompt for the per-step agentic loop.
   * Uses the same flat-line REASONING/DECISION/ACTION/PARAM_* format as the
   * codebase tool-plan, but scoped to computer-use actions.
   */
  private static readonly CU_AGENT_SYSTEM = `\
You are a computer-use verification agent. The primary action has ALREADY been executed.
You see a screenshot of the CURRENT screen and decide: is the step done, or is a corrective action needed?

═══ OUTPUT FORMAT (one field per line, NO JSON, NO markdown) ═══

REASONING: one sentence describing what you see on screen
DECISION: DONE
RESULT: what was accomplished (for read_screen, list ALL visible text)

OR

REASONING: one sentence describing what you see and why correction is needed
DECISION: ACT
ACTION: navigate
PARAM_TARGET: https://example.com

OR

REASONING: one sentence describing what went wrong
DECISION: FAILED
RESULT: what went wrong

═══ VALID ACTIONS (only when DECISION is ACT) ═══
navigate, click, type, scroll, screenshot, read_screen, key_press, wait

═══ RULES ═══
- The primary action was already executed. If the screen shows the expected result, say DONE.
- For navigate steps: if the page loaded (even partially), say DONE.
- For wait steps: always say DONE (the wait already happened).
- For read_screen steps: say DONE and put ALL visible text in RESULT.
- Only say ACT if the screen shows an error, wrong page, or the action clearly failed.
- For click: describe element by visual appearance and position (e.g. "avatar icon top-right").
- NEVER interact with localhost:3000 or any "Oasis" UI.
- If the screen is blank/black, say FAILED.
- Keep REASONING to ONE sentence.

═══ CRITICAL: SCROLL BEFORE CLICK ═══
- If you need to click an element but CANNOT see it on screen, do NOT click blindly.
- Instead, ACTION: scroll with PARAM_TARGET: down (or up) to bring the element into view FIRST.
- Only click elements you can actually SEE in the current screenshot.
- If the step says "click X" but X is not visible, scroll to find it.

═══ CRITICAL: DEAD-END DETECTION ═══
- If SCREEN_UNCHANGED is mentioned, your previous action had NO visible effect.
- Do NOT repeat the same action — it will fail again.
- Try a DIFFERENT approach: scroll instead of click, navigate instead of scroll, use a different target.
- If you've tried multiple approaches and the screen won't change, say FAILED.`;

  /**
   * Parse a flat-line CU agent response into structured fields.
   * Mirrors the codebase tool-plan parser but simpler (fewer fields).
   */
  private parseCUAgentResponse(raw: string): {
    reasoning: string;
    decision: 'ACT' | 'DONE' | 'FAILED';
    action?: string;
    target?: string;
    result?: string;
  } {
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l);

    let reasoning = '';
    let decision: 'ACT' | 'DONE' | 'FAILED' = 'ACT';
    let action: string | undefined;
    let target: string | undefined;
    let result: string | undefined;

    for (const line of lines) {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      const k = key.trim().toUpperCase();

      if (k === 'REASONING') reasoning = value;
      else if (k === 'DECISION') {
        const d = value.toUpperCase().trim();
        if (d === 'DONE') decision = 'DONE';
        else if (d === 'FAILED') decision = 'FAILED';
        else {
          decision = 'ACT';
          // Handle "ACT | action_name" or "ACT | action_name | target" format
          // (LLM sometimes puts action on the DECISION line separated by pipes)
          const parts = value.split('|').map(p => p.trim().toLowerCase());
          if (parts.length >= 2 && parts[0] === 'act') {
            action = action || parts[1];
            if (parts.length >= 3) target = target || parts.slice(2).join('|').trim();
          }
        }
      }
      else if (k === 'ACTION') action = value.toLowerCase().trim();
      else if (k === 'PARAM_TARGET' || k === 'TARGET') target = value;
      else if (k === 'RESULT') result = value;
    }

    // Fallback: try to extract from JSON if LLM ignored flat-line instructions
    if (!action && decision === 'ACT') {
      try {
        const jsonMatch = raw.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          action = parsed.action;
          target = parsed.target || parsed.param_target;
          reasoning = parsed.reasoning || reasoning;
          if (parsed.decision?.toUpperCase() === 'DONE') decision = 'DONE';
          if (parsed.decision?.toUpperCase() === 'FAILED') decision = 'FAILED';
          if (parsed.result) result = parsed.result;
        }
      } catch { /* ignore JSON parse failures */ }
    }

    return { reasoning, decision, action, target, result };
  }

  /**
   * Run a single high-level plan step using an agentic loop.
   *
   * The LLM sees the current screen after each action and decides the next move.
   * No separate "observe and verify" — the LLM verifies implicitly by looking at
   * the screenshot. It says DONE only when it confirms the step succeeded.
   *
   * Returns { success, output } where output contains extracted data if any.
   */
  private async executeStepAgentLoop(
    sessionId: string,
    step: PlanStep,
    goal: string,
  ): Promise<{ success: boolean; output: string }> {
    const session = sessions.get(sessionId);
    if (!session) return { success: false, output: 'Session not found' };

    const shareCtx = this.getShareContext(sessionId);
    step.sub_steps = [];

    // Consume user steering feedback
    const feedbackQueue: string[] = (session as any)?._feedback_queue || [];
    let feedbackContext = '';
    if (feedbackQueue.length > 0) {
      feedbackContext = `\nUSER FEEDBACK (follow these instructions from the human operator):\n` +
        feedbackQueue.map(f => `  - ${f}`).join('\n') + '\n';
      (session as any)._feedback_queue = [];
    }

    // Gather context from previous steps
    const previousOutputs = session.plan
      .filter(s => s.index < step.index && s.status === 'completed' && s.output)
      .map(s => `  Step ${s.index + 1} [${s.action}]: ${s.output!.slice(0, 500)}`)
      .join('\n');

    const discoveries = (session as any)?._discoveries || {};
    const discoveryCtx = Object.keys(discoveries).length > 0
      ? `\nDISCOVERED VALUES (use these in URLs/actions):\n` +
        Object.entries(discoveries).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n'
      : '';

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1: Execute the step's primary action FIRST.
    // The plan step already specifies what to do (navigate, click, scroll, etc.)
    // We execute it directly — no LLM needed for this part.
    // ══════════════════════════════════════════════════════════════════════════

    const actionHistory: string[] = [];
    let primaryOutput = '';

    try {
      this.logger.log(`Step ${step.index + 1} executing primary action: ${step.action}${step.target ? ` → ${step.target}` : ''}`);

      const primaryResult = await this.executeComputerAction(step, sessionId);
      primaryOutput = primaryResult.output;
      if (primaryResult.screenshot) session.live_screenshot = primaryResult.screenshot;

      const primarySub = {
        index: 0,
        description: `${step.action}${step.target ? `: ${step.target}` : ''}`,
        action: step.action,
        target: step.target,
        status: 'completed' as const,
        output: primaryOutput,
        screenshot: primaryResult.screenshot,
      };
      step.sub_steps!.push(primarySub);
      actionHistory.push(`  1. [PRIMARY] ${step.action}${step.target ? ` "${step.target.slice(0, 80)}"` : ''} → ${primaryOutput.slice(0, 150)}`);

      this.logger.log(`Step ${step.index + 1} primary action done: ${primaryOutput.slice(0, 200)}`);
    } catch (err: any) {
      this.logger.warn(`Step ${step.index + 1} primary action failed: ${err.message}`);
      step.sub_steps!.push({
        index: 0,
        description: `${step.action}${step.target ? `: ${step.target}` : ''}`,
        action: step.action,
        target: step.target,
        status: 'failed' as const,
        output: err.message,
      });
      actionHistory.push(`  1. [PRIMARY] ${step.action} → FAILED: ${err.message}`);
      // Don't return yet — let the agent loop try to recover
    }

    session.updated_at = new Date().toISOString();

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Agent verification loop.
    //
    // SKIP verification for actions where primary output is already the answer:
    //   - read_screen: the 3-step cascade already extracted text; verification
    //     would just summarize/lose data
    //   - wait: always succeeds
    //   - scroll: primary action reports success
    //
    // Only run verification for interactive actions where we need visual
    // confirmation: navigate, click, type.
    // ══════════════════════════════════════════════════════════════════════════

    let lastOutput = primaryOutput;
    const actionLower2 = step.action.toLowerCase();
    const skipVerification = ['read_screen', 'read_page', 'extract_text', 'wait', 'scroll', 'screenshot'].includes(actionLower2);

    if (skipVerification) {
      this.logger.log(`Step ${step.index + 1}: skipping verification for "${step.action}" — primary output is the answer`);
      step.output = primaryOutput || `${step.action} executed`;
      return { success: primaryOutput !== '', output: step.output };
    }

    // Check if we can actually see the screen
    const verifyScreen = await this.getScreenImage(sessionId);
    if (!verifyScreen) {
      this.logger.warn(`Step ${step.index + 1}: no screenshot available — skipping verification, trusting primary action output`);
      step.output = primaryOutput || `${step.action} executed (no visual verification available)`;
      return { success: primaryOutput !== '', output: step.output };
    }

    let prevScreenHash = this.quickScreenHash(verifyScreen);
    let unchangedCount = 0;

    for (let actionNum = 1; actionNum < ComputerUseController.MAX_ACTIONS_PER_STEP; actionNum++) {
      if (session.status !== 'executing') return { success: false, output: 'Session paused/cancelled' };

      // Get fresh screenshot after the previous action
      const screen = actionNum === 1 ? verifyScreen : await this.getScreenImage(sessionId);
      if (!screen) {
        // Lost access to screenshots mid-step — stop verification
        this.logger.warn(`Step ${step.index + 1}: screenshot disappeared during verification — accepting current output`);
        break;
      }

      // ── Dead-end detection: compare screenshots ──
      const currHash = this.quickScreenHash(screen);
      let screenUnchanged = false;
      if (actionNum > 1) {
        if (currHash === prevScreenHash) {
          unchangedCount++;
          screenUnchanged = true;
          this.logger.warn(`Step ${step.index + 1}: screen unchanged after action ${actionNum} (${unchangedCount} consecutive)`);
          if (unchangedCount >= 3) {
            this.logger.error(`Step ${step.index + 1}: screen stuck after 3 consecutive unchanged actions — failing step`);
            return { success: false, output: `Dead end: screen did not change after ${unchangedCount} corrective actions` };
          }
        } else {
          unchangedCount = 0;
        }
      }
      prevScreenHash = currHash;

      const historyBlock = `\nACTIONS ALREADY EXECUTED:\n${actionHistory.join('\n')}\n`;

      // Build action-specific verification hint
      const actionLower = step.action.toLowerCase();
      let verifyHint = '';
      if (actionLower === 'navigate') {
        verifyHint = `This was a NAVIGATE action. If the page loaded (even partially), say DONE. Do NOT take additional actions — the next step will handle that.`;
      } else if (actionLower === 'wait') {
        verifyHint = `This was a WAIT action. The wait already completed. Say DONE.`;
      } else if (actionLower === 'read_screen' || actionLower === 'read_page') {
        verifyHint = `This was a READ_SCREEN action. Look at the screenshot and list ALL visible text content in RESULT. Include every heading, label, item name, and link text you can see. Say DONE.`;
      } else if (actionLower === 'click') {
        verifyHint = `This was a CLICK action. If the click produced a visible result (page change, menu opened, etc.), say DONE. Only say ACT if the click clearly missed or nothing changed.`;
      } else if (actionLower === 'scroll') {
        verifyHint = `This was a SCROLL action. If the page scrolled (content changed), say DONE.`;
      }

      // Inject dead-end warning if screen hasn't changed
      const deadEndWarning = screenUnchanged
        ? `\n⚠️ SCREEN_UNCHANGED: The screen looks IDENTICAL to before your last action. Your previous action had NO effect. Do NOT repeat it. Try a completely different approach (e.g., scroll instead of click, navigate to a different URL, use a different target element).\n`
        : '';

      const userMessage =
        `OVERALL GOAL: ${goal}\n` +
        `CURRENT STEP (${step.index + 1}/${session.plan.length}): ${step.description}\n` +
        `STEP ACTION: ${step.action}${step.target ? ` → ${step.target}` : ''}\n` +
        `${previousOutputs ? `\nINFO FROM PREVIOUS STEPS:\n${previousOutputs}\n` : ''}` +
        `${discoveryCtx}${feedbackContext}` +
        `SHARED SCREEN: ${shareCtx}\n` +
        `${historyBlock}${deadEndWarning}\n` +
        `The primary action "${step.action}" has ALREADY been executed. Screenshot of current screen is attached.\n` +
        `${verifyHint}\n`;

      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message: userMessage,
        context: {
          system_override: ComputerUseController.CU_AGENT_SYSTEM,
          max_tokens: 1024,
          screen_image: screen,
        },
      }, { timeout: LLM_TIMEOUT_MS });

      const rawResponse: string = res.data?.response_text || res.data?.response || '';
      this.logger.log(`CU Agent step ${step.index + 1} verify ${actionNum}: ${rawResponse.slice(0, 300)}`);

      const parsed = this.parseCUAgentResponse(rawResponse);

      // ── DONE: step verified ──
      if (parsed.decision === 'DONE') {
        lastOutput = parsed.result || primaryOutput || 'Step completed';
        step.output = lastOutput;
        this.logger.log(`Step ${step.index + 1} VERIFIED DONE: ${lastOutput.slice(0, 200)}`);
        return { success: true, output: lastOutput };
      }

      // ── FAILED: step cannot be completed ──
      if (parsed.decision === 'FAILED') {
        lastOutput = parsed.result || parsed.reasoning || 'Step failed';
        this.logger.warn(`Step ${step.index + 1} agent says FAILED: ${lastOutput}`);
        return { success: false, output: lastOutput };
      }

      // ── ACT: corrective action needed ──
      if (!parsed.action) {
        this.logger.warn(`Step ${step.index + 1} verify ${actionNum}: no action parsed`);
        actionHistory.push(`  ${actionNum + 1}. [ERROR] Could not parse action from LLM`);
        continue;
      }

      const subStep: { index: number; description: string; action: string; target?: string; status: string; output?: string; screenshot?: string } = {
        index: actionNum,
        description: parsed.reasoning || `${parsed.action} ${parsed.target || ''}`.trim(),
        action: parsed.action,
        target: parsed.target,
        status: 'running',
      };
      step.sub_steps!.push(subStep as any);
      session.updated_at = new Date().toISOString();

      try {
        const result = await this.executeComputerAction(
          { index: step.index, description: subStep.description, action: parsed.action, target: parsed.target, status: 'running' } as PlanStep,
          sessionId,
        );
        subStep.output = result.output;
        subStep.screenshot = result.screenshot;
        subStep.status = 'completed';
        if (result.screenshot) session.live_screenshot = result.screenshot;
        lastOutput = result.output;

        actionHistory.push(`  ${actionNum + 1}. ${parsed.action}${parsed.target ? ` "${parsed.target.slice(0, 60)}"` : ''} → ${result.output.slice(0, 150)}`);
      } catch (err: any) {
        subStep.status = 'failed';
        subStep.output = err.message;
        actionHistory.push(`  ${actionNum + 1}. ${parsed.action} → FAILED: ${err.message}`);
        this.logger.warn(`Step ${step.index + 1} corrective action ${actionNum} failed: ${err.message}`);
      }

      session.updated_at = new Date().toISOString();
      await new Promise(r => setTimeout(r, 300));
    }

    // Exceeded max actions — use whatever output we got from the primary action
    step.output = lastOutput || 'Step completed (verification timed out)';
    this.logger.warn(`Step ${step.index + 1} hit max verification actions — accepting primary result`);
    return { success: true, output: step.output };
  }

  /**
   * Execute plan steps using an agentic loop per step.
   *
   * Architecture:
   *   1. For each high-level step, run an agentic loop (LLM decides actions one at a time)
   *   2. The LLM sees the screen after each action — validation is implicit
   *   3. LLM says DONE when it confirms the step succeeded (no separate observation)
   *   4. If step fails, rewrite remaining plan from this step forward
   *   5. Discovery tokens (__DISCOVERED_*__) get replaced from read_screen output
   */
  private async executeSteps(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    const guard = validateSessionForExecution(session);
    if (!guard.allowed) {
      session.status = 'failed';
      session.error = guard.reason;
      session.updated_at = new Date().toISOString();
      return;
    }

    while (session.current_step < session.plan.length) {
      if (session.status !== 'executing') return;

      const step = session.plan[session.current_step];

      // Step-by-step approval mode
      if (session.policy.require_step_approval && step.status === 'pending') {
        session.status = 'paused';
        session.updated_at = new Date().toISOString();
        return;
      }

      // Policy guard
      const guardResult = evaluateStepPolicy(step, session.policy, {
        visionGranted: session.visionGranted,
        stepsExecuted: session.current_step,
        sessionStartedAt: session.created_at,
      });
      if (!guardResult.allowed) {
        step.status = 'blocked';
        step.block_reason = guardResult.reason;
        step.completed_at = new Date().toISOString();
        session.current_step++;
        session.updated_at = new Date().toISOString();
        continue;
      }

      // ── Guard: resolve any remaining __DISCOVERED_*__ tokens before executing ──
      // If the step target still contains unresolved tokens, do a read_screen first
      // to try to discover values, rather than navigating to a literal placeholder URL.
      if (step.target && /__DISCOVERED_\w+__/.test(step.target)) {
        this.logger.warn(`Step ${step.index + 1} has unresolved tokens in target: "${step.target}" — running discovery read_screen`);
        try {
          const discoveryStep = { action: 'read_screen', target: '', index: step.index } as PlanStep;
          const { output: discOutput } = await this.executeComputerAction(discoveryStep, sessionId);
          if (discOutput) {
            await this.replaceDiscoveryTokens(session, { ...discoveryStep, output: discOutput } as PlanStep);
          }
        } catch (err: any) {
          this.logger.warn(`Discovery read_screen failed: ${err.message}`);
        }
        // If tokens STILL unresolved after discovery attempt, fail the step early
        if (/__DISCOVERED_\w+__/.test(step.target)) {
          this.logger.error(`Step ${step.index + 1} still has unresolved tokens after discovery: "${step.target}"`);
          step.status = 'failed';
          step.output = `Could not resolve placeholder tokens in "${step.target}". The required value was not found on screen.`;
          step.started_at = new Date().toISOString();
          step.completed_at = new Date().toISOString();
          session.updated_at = new Date().toISOString();

          // Trigger plan revision so the LLM can try a different approach
          const revisionCount = (session as any)._revision_count || 0;
          if (revisionCount < ComputerUseController.MAX_PLAN_REVISIONS) {
            this.logger.log(`Revising plan due to unresolved tokens (revision ${revisionCount + 1})`);
            try {
              await this.revisePlan(sessionId, session.goal, session.policy, session.plan);
              (session as any)._revision_count = revisionCount + 1;
              continue;
            } catch { /* fall through */ }
          }
          session.status = 'failed';
          session.error = `Could not discover required values for step "${step.description}"`;
          return;
        }
      }

      // ── Execute step via agentic loop ──
      step.status = 'running';
      step.started_at = new Date().toISOString();
      session.updated_at = new Date().toISOString();

      this.logger.log(`Step ${step.index + 1}/${session.plan.length} "${step.description}" — starting agent loop`);
      const { success, output } = await this.executeStepAgentLoop(sessionId, step, session.goal);

      step.completed_at = new Date().toISOString();

      if (success) {
        step.status = 'completed';
        step.output = output;
        this.logger.log(`Step ${step.index + 1} COMPLETED: ${step.description} → ${output.slice(0, 200)}`);

        // ── Discovery: extract values from read_screen output for future steps ──
        if ((step.action === 'read_screen' || step.action === 'read_page') && output) {
          await this.replaceDiscoveryTokens(session, step);
        }
        if (step.sub_steps) {
          for (const sub of step.sub_steps) {
            if ((sub.action === 'read_screen' || sub.action === 'read_page') && sub.output) {
              await this.replaceDiscoveryTokens(session, sub as PlanStep);
            }
          }
        }

        session.current_step++;
      } else {
        step.status = 'failed';
        step.output = output;
        this.logger.error(`Step ${step.index + 1} FAILED: ${output.slice(0, 300)}`);

        // ── Rewrite remaining plan from this step forward ──
        const revisionCount = (session as any)._revision_count || 0;
        if (revisionCount < ComputerUseController.MAX_PLAN_REVISIONS) {
          this.logger.log(`Rewriting plan from step ${session.current_step + 1} forward (revision ${revisionCount + 1})`);
          try {
            await this.revisePlan(sessionId, session.goal, session.policy, session.plan);
            (session as any)._revision_count = revisionCount + 1;
            // Don't increment current_step — the revision replaces from current step forward
            continue;
          } catch (err: any) {
            this.logger.error(`Plan revision failed: ${err.message}`);
          }
        }

        // Cannot recover
        session.status = 'failed';
        session.error = `Step "${step.description}" failed and could not be recovered after ${revisionCount} plan revisions`;
        session.updated_at = new Date().toISOString();
        return;
      }

      session.updated_at = new Date().toISOString();
    }

    // All steps done — but is the GOAL actually satisfied?
    if (session.status === 'executing') {
      const goalRevisionCount = (session as any)._goal_revision_count || 0;
      if (goalRevisionCount < 2) {
        // Check goal satisfaction via LLM with current screen
        const goalSatisfied = await this.checkGoalSatisfaction(sessionId, session.goal, session.plan);
        if (!goalSatisfied) {
          this.logger.log(`Goal not yet satisfied after all steps — revising plan (attempt ${goalRevisionCount + 1})`);
          (session as any)._goal_revision_count = goalRevisionCount + 1;
          try {
            await this.revisePlan(sessionId, session.goal, session.policy, session.plan, true);
            // Continue executing new steps
            const newSteps = session.plan.filter(s => s.status === 'pending');
            if (newSteps.length > 0) {
              this.logger.log(`Plan extended with ${newSteps.length} new steps — continuing execution`);
              return this.executeSteps(sessionId);
            }
          } catch (err: any) {
            this.logger.error(`Goal-satisfaction revision failed: ${err.message}`);
          }
        }
      }

      session.status = 'completed';
      session.updated_at = new Date().toISOString();
      this.logger.log(`Session ${sessionId} COMPLETED — all steps succeeded`);

      // Generate summary for chat
      this.generateSessionSummary(sessionId).catch(err => {
        this.logger.warn(`Summary generation failed: ${err.message}`);
      });
    }

    // Also generate summary on failure so the user knows what happened
    if (session.status === 'failed') {
      this.generateSessionSummary(sessionId).catch(err => {
        this.logger.warn(`Summary generation failed: ${err.message}`);
      });
    }

  }

  /**
   * Generate a concise summary of the CU session results and store it on the session.
   * This is what gets shown in chat when the session completes.
   */
  private async generateSessionSummary(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    // Collect all read_screen outputs — these contain the actual data
    const dataOutputs = session.plan
      .filter(s => s.status === 'completed' && s.output && s.output.length > 20)
      .filter(s => s.action === 'read_screen' || s.action === 'read_page')
      .map(s => s.output!)
      .slice(-3); // Last 3 read_screen outputs (most relevant)

    // Also get the last step output regardless of type
    const lastCompleted = [...session.plan].reverse().find(s => s.status === 'completed' && s.output);
    const failedStep = session.plan.find(s => s.status === 'failed');

    const dataContext = dataOutputs.length > 0
      ? `DATA EXTRACTED FROM SCREEN:\n${dataOutputs.join('\n---\n').slice(0, 4000)}`
      : lastCompleted?.output
        ? `LAST STEP OUTPUT:\n${lastCompleted.output.slice(0, 2000)}`
        : 'No data was extracted.';

    const statusContext = session.status === 'failed'
      ? `The session FAILED.${failedStep ? ` Step "${failedStep.description}" failed: ${failedStep.output?.slice(0, 300)}` : ''}\n${session.error || ''}`
      : `The session completed successfully.`;

    const prompt =
      `You are summarizing the results of a computer-use task.\n\n` +
      `GOAL: ${session.goal}\n` +
      `STATUS: ${statusContext}\n\n` +
      `${dataContext}\n\n` +
      `Write a concise, helpful response that directly answers the user's original request.\n` +
      `- If the data contains a list (repos, files, items), format it as a clean bullet list.\n` +
      `- If the task failed, explain what went wrong briefly.\n` +
      `- Do NOT mention "steps", "sessions", "OCR", or internal implementation details.\n` +
      `- Write as if YOU did the work and are reporting back.`;

    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message: prompt,
        context: {
          system_override: 'You are Oasis, a helpful assistant. Summarize computer-use task results concisely for the user. Use markdown formatting.',
          max_tokens: 1024,
        },
      }, { timeout: LLM_TIMEOUT_MS });

      const summary = res.data?.response_text || res.data?.response || '';
      if (summary) {
        (session as any).summary = summary.trim();
        session.updated_at = new Date().toISOString();
        this.logger.log(`Session ${sessionId} summary generated (${summary.length} chars)`);
      }
    } catch (err: any) {
      // Fallback: create a basic summary from the data
      const fallback = session.status === 'failed'
        ? `I tried to ${session.goal} but encountered an error: ${session.error || 'unknown error'}`
        : dataOutputs.length > 0
          ? `Here's what I found for "${session.goal}":\n\n${dataOutputs[dataOutputs.length - 1]?.slice(0, 1000) || 'Task completed.'}`
          : `I completed the task: ${session.goal}`;
      (session as any).summary = fallback;
      this.logger.warn(`Summary LLM failed, using fallback: ${err.message}`);
    }
  }

  /**
   * Check whether the original goal is satisfied based on step outputs and current screen.
   * Returns true if goal is met, false if more work is needed.
   */
  private async checkGoalSatisfaction(
    sessionId: string,
    goal: string,
    plan: PlanStep[],
  ): Promise<boolean> {
    const currentScreen = await this.getScreenImage(sessionId);

    // Use Chrome Bridge get_page_text for reliable text (falls back to OCR)
    let screenText = '';
    try {
      const textRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
        tool: 'computer_action',
        action: 'get_page_text',
      }, { timeout: 15000 });
      if (textRes.data?.success && textRes.data.output) {
        screenText = textRes.data.output as string;
      }
    } catch { /* ignore */ }
    if (!screenText) {
      try {
        const screenRegion = this.getScreenRegion(sessionId);
        const ocrPayload: Record<string, any> = { tool: 'computer_action', action: 'ocr_screenshot' };
        if (screenRegion) ocrPayload.screen_region = screenRegion;
        const ocrRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
          ocrPayload, { timeout: 30000 });
        if (ocrRes.data?.success && ocrRes.data.output) {
          screenText = ocrRes.data.output as string;
        }
      } catch { /* ignore */ }
    }

    // Collect data already extracted by read_screen steps
    const readScreenOutputs = plan
      .filter(s => s.status === 'completed' && s.output && (s.action === 'read_screen' || s.action === 'read_page'))
      .map(s => s.output!)
      .slice(-2); // Last 2 read_screen outputs
    const extractedData = readScreenOutputs.length > 0
      ? `\nDATA ALREADY EXTRACTED BY PREVIOUS STEPS:\n${readScreenOutputs.join('\n---\n').slice(0, 3000)}\n`
      : '';

    const stepSummary = plan
      .filter(s => s.status === 'completed')
      .map(s => `  Step ${s.index + 1}: "${s.action}" ${s.description}`)
      .join('\n');

    const prompt =
      `GOAL: ${goal}\n\n` +
      `COMPLETED STEPS:\n${stepSummary}\n\n` +
      extractedData +
      `CURRENT SCREEN TEXT:\n${screenText.slice(0, 2000)}\n\n` +
      `${currentScreen ? 'A screenshot of the current screen is attached.\n\n' : ''}` +
      `Question: Has the goal been achieved? The key question is whether the REQUESTED DATA has been captured in the step outputs above.\n\n` +
      `Rules:\n` +
      `- If the DATA ALREADY EXTRACTED section contains the answer to the user's goal (e.g., a list of repos, a piece of information), the goal IS satisfied — even if more data MIGHT exist.\n` +
      `- The goal is to EXTRACT information, not to display it perfectly on screen. Data in step outputs counts.\n` +
      `- Only say "no" if the extracted data is clearly incomplete (e.g., a "Next page" link was visible and not followed) or the steps failed to reach the right page.\n` +
      `- When in doubt, say YES — it's better to return partial results than loop forever.\n\n` +
      `Answer EXACTLY one line:\n` +
      `SATISFIED: yes\n` +
      `or\n` +
      `SATISFIED: no | <brief reason>`;

    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message: prompt,
        context: {
          system_override:
            `You check whether a computer-use goal is satisfied based on extracted data. ` +
            `The data is in the step outputs — if it answers the user's question, say yes. ` +
            `Answer ONLY with "SATISFIED: yes" or "SATISFIED: no | reason".`,
          max_tokens: 256,
          ...(currentScreen ? { screen_image: currentScreen } : {}),
        },
      }, { timeout: LLM_TIMEOUT_MS });

      const text: string = res.data?.response_text || res.data?.response || '';
      this.logger.log(`Goal satisfaction check: ${text.trim()}`);

      const lower = text.toLowerCase();
      if (lower.includes('satisfied: yes') || lower.includes('satisfied:yes')) {
        return true;
      }
      return false;
    } catch (err: any) {
      this.logger.warn(`Goal satisfaction check failed: ${err.message} — assuming satisfied`);
      return true;
    }
  }

  /**
   * Revise a plan based on execution results + current screen state.
   * Sends the screen-share image so the revision is grounded in what's actually on screen.
   */
  private async revisePlan(
    sessionId: string,
    goal: string,
    policy: typeof DEFAULT_POLICY,
    previousPlan: PlanStep[],
    goalNotSatisfied = false,
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    // Get fresh screen for the revision
    const currentScreen = await this.getScreenImage(sessionId);
    const shareCtx = this.getShareContext(sessionId);

    const stepSummary = previousPlan
      .map(s => {
        const label = s.status === 'failed' ? '❌ FAILED' : s.status === 'completed' ? '✓ done' : s.status;
        return `  Step ${s.index + 1} [${label}]: "${s.action}" ${s.description}${s.output ? `\n    Output: ${s.output.slice(0, 300)}` : ''}`;
      })
      .join('\n');

    const contextLine = goalNotSatisfied
      ? `All steps completed successfully, but the GOAL is NOT yet fully satisfied. The screen shows there is more to do (e.g., "View all repositories", "Show more", pagination links). You must add steps to finish the job.\n\n`
      : `The plan partially FAILED. Some steps did not work as expected.\n\n`;

    // Include discovered values so revision plan can use them directly
    const existingDiscoveries = (session as any)?._discoveries || {};
    const discoveryCtx = Object.keys(existingDiscoveries).length > 0
      ? `\nDISCOVERED VALUES (use these directly in URLs, do NOT use __DISCOVERED_*__ placeholders):\n` +
        Object.entries(existingDiscoveries).map(([k, v]) => `  ${k} = "${v}"`).join('\n') + '\n\n'
      : `\nIMPORTANT: __DISCOVERED_*__ token replacement FAILED — the username could not be extracted from OCR text.\n` +
        `Do NOT use __DISCOVERED_*__ tokens. Instead, try a different approach:\n` +
        `- Use "click" to click on the profile/avatar icon to navigate to the profile page\n` +
        `- Or use "click" to click on "Your repositories" link in the GitHub dropdown menu\n` +
        `- Or use "navigate" to https://github.com and then "click" the profile avatar\n\n`;

    // Include data already captured so the LLM knows what's been found
    const capturedData = previousPlan
      .filter(s => s.status === 'completed' && s.output && (s.action === 'read_screen' || s.action === 'read_page'))
      .map(s => s.output!)
      .slice(-2)
      .join('\n---\n')
      .slice(0, 2000);
    const capturedCtx = capturedData
      ? `\nDATA ALREADY CAPTURED (from completed read_screen steps):\n${capturedData}\n\n`
      : '';

    const revisionPrompt =
      contextLine +
      `GOAL: ${goal}\n\n` +
      `SHARED SCREEN: ${shareCtx}\n\n` +
      discoveryCtx +
      capturedCtx +
      `PREVIOUS PLAN RESULTS:\n${stepSummary}\n\n` +
      `${currentScreen ? 'A screenshot of the CURRENT screen state is attached. Look at it to understand where we are now.\n\n' : ''}` +
      `Create a NEW plan to complete the remaining goal from the current state.\n` +
      `IMPORTANT: If the DATA ALREADY CAPTURED section above contains the answer to the goal (e.g., a list of repos), you may only need a final "read_screen" to confirm — do NOT re-navigate to pages already visited.\n` +
      `Output one step per line in this format:\n` +
      `STEP: <action> | <target or empty> | <description>\n\n` +
      `Valid actions: navigate, click, type, scroll, read_screen, key_press, wait\n\n` +
      `EFFICIENCY RULES:\n` +
      `- NEVER use "screenshot" as a step — use "read_screen" instead (it captures screenshot AND text)\n` +
      `- NEVER put "wait" after "navigate" — navigate already waits\n` +
      `- PREFER "navigate" with direct URL over "click" — URLs are more reliable\n` +
      `- Generate 2-5 steps maximum. Fewer is better.\n` +
      `- One "read_screen" per page is enough. Don't repeat unless you scrolled.\n\n` +
      `Rules:\n` +
      `- Do NOT repeat steps that already succeeded\n` +
      `${goalNotSatisfied
        ? '- The previous steps did NOT fully achieve the goal. Look at the screenshot — if there is a direct URL (like https://github.com/orgs/ORGNAME/repositories), navigate there directly instead of clicking.\n'
        : '- Use a DIFFERENT approach for failed actions (e.g., if click failed, use navigate with direct URL instead)\n'}` +
      `- Be SPECIFIC about element descriptions for click targets\n` +
      `- Only use well-known URLs. Do NOT fabricate URLs.\n` +
      `${goalNotSatisfied ? '- Go straight to the action needed. No screenshot/read_screen first.\n' : '- Start with read_screen to verify current state\n'}` +
      `- Max ${Math.min(policy.max_steps, 6)} steps\n\n` +
      `Output ONLY STEP: lines, nothing else.`;

    const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
      user_message: revisionPrompt,
      context: {
        system_override:
          `You are revising a failed computer-use plan. Look at the screenshot. ` +
          `Output ONLY flat STEP: lines. Format: STEP: action | target | description. ` +
          `One step per line. No JSON, no markdown, no prose.`,
        max_tokens: 2048,
        ...(currentScreen ? { screen_image: currentScreen } : {}),
      },
    }, { timeout: LLM_TIMEOUT_MS });

    const text: string = res.data?.response_text || res.data?.response || '';
    this.logger.log(`Revision LLM response: ${text.slice(0, 300)}`);

    const rawSteps = this.parseStepLines(text);

    // Fallback: try JSON extraction if flat-line format wasn't followed
    if (rawSteps.length === 0) {
      const jsonStr = this.extractJsonArray(text);
      if (jsonStr) {
        const jsonSteps = JSON.parse(jsonStr) as Array<{ description: string; action: string; target?: string }>;
        if (Array.isArray(jsonSteps) && jsonSteps.length > 0) {
          rawSteps.push(...jsonSteps);
        }
      }
    }

    if (rawSteps.length === 0) {
      throw new Error('Revision LLM did not return a valid plan');
    }

    // Optimize revised steps too
    const optimizedSteps = this.optimizePlanSteps(rawSteps);

    // REPLACE plan from current step forward (keep completed steps, replace the rest)
    const keepSteps = session.plan.slice(0, session.current_step);
    const baseIndex = keepSteps.length;
    const newSteps: PlanStep[] = optimizedSteps.map((s, i) => ({
      index: baseIndex + i,
      description: s.description || `Revision step ${i + 1}`,
      action: s.action || 'read_screen',
      target: s.target,
      status: 'pending' as const,
    }));

    session.plan = [...keepSteps, ...newSteps];
    session.updated_at = new Date().toISOString();
    this.logger.log(`Plan revised for ${sessionId}: replaced from step ${baseIndex + 1} forward — ${newSteps.length} new steps (total ${session.plan.length})`);
  }

  /**
   * Parse flat "STEP: action | target | description" lines from LLM output.
   * Also handles variations like "STEP 1: ..." or "1. navigate | ..."
   */
  private parseStepLines(text: string): Array<{ description: string; action: string; target?: string }> {
    const steps: Array<{ description: string; action: string; target?: string }> = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    for (const line of lines) {
      // Match "STEP: action | target | description" or "STEP 1: action | target | description"
      const stepMatch = line.match(/^(?:STEP\s*\d*\s*:\s*)(.*)/i);
      if (stepMatch) {
        const parts = stepMatch[1].split('|').map(p => p.trim());
        if (parts.length >= 2) {
          steps.push({
            action: parts[0].toLowerCase(),
            target: parts[1] || undefined,
            description: parts[2] || parts[1] || parts[0],
          });
        } else if (parts.length === 1) {
          steps.push({
            action: parts[0].toLowerCase(),
            description: parts[0],
          });
        }
        continue;
      }

      // Also match numbered lines: "1. navigate | https://... | Go to page"
      const numberedMatch = line.match(/^\d+\.\s+(.*)/);
      if (numberedMatch) {
        const parts = numberedMatch[1].split('|').map(p => p.trim());
        if (parts.length >= 2) {
          steps.push({
            action: parts[0].toLowerCase(),
            target: parts[1] || undefined,
            description: parts[2] || parts[1] || parts[0],
          });
        }
      }
    }

    return steps;
  }

  /**
   * Remove redundant/wasteful steps from a plan.
   * - Remove standalone "screenshot" steps (read_screen does the same + extracts text)
   * - Remove "wait" steps that immediately follow "navigate" (navigate already waits)
   * - Collapse consecutive "read_screen" without a scroll between them
   * - Convert "screenshot" action to "read_screen"
   */
  private optimizePlanSteps(
    steps: Array<{ description: string; action: string; target?: string }>,
  ): Array<{ description: string; action: string; target?: string }> {
    const result: Array<{ description: string; action: string; target?: string }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const action = step.action.toLowerCase();
      const prevAction = result.length > 0 ? result[result.length - 1].action.toLowerCase() : '';

      // Convert standalone "screenshot" to "read_screen"
      if (action === 'screenshot') {
        // Skip if next step is read_screen (it will do the screenshot)
        const nextAction = i + 1 < steps.length ? steps[i + 1].action.toLowerCase() : '';
        if (nextAction === 'read_screen') {
          this.logger.log(`Plan optimize: dropping standalone screenshot before read_screen (step ${i + 1})`);
          continue;
        }
        // Otherwise convert to read_screen
        step.action = 'read_screen';
        step.description = step.description.replace(/screenshot/gi, 'read screen');
        this.logger.log(`Plan optimize: converting screenshot → read_screen (step ${i + 1})`);
      }

      // Skip "wait" after "navigate" (navigate already waits for page load)
      if (action === 'wait' && prevAction === 'navigate') {
        this.logger.log(`Plan optimize: dropping wait after navigate (step ${i + 1})`);
        continue;
      }

      // Skip consecutive read_screen without scroll/navigate/click between them
      if (action === 'read_screen' && prevAction === 'read_screen') {
        this.logger.log(`Plan optimize: dropping duplicate read_screen (step ${i + 1})`);
        continue;
      }

      result.push(step);
    }

    return result;
  }

  /**
   * After a read_screen step completes, extract discoverable values (like usernames)
   * and replace __DISCOVERED_*__ tokens in remaining plan steps.
   *
   * This enables a two-phase pattern:
   *   Step 1: read_screen → extracts "stevetran" from GitHub profile
   *   Step 2: navigate to "https://github.com/__DISCOVERED_USERNAME__?tab=repositories"
   *           → becomes "https://github.com/stevetran?tab=repositories"
   */
  private async replaceDiscoveryTokens(
    session: ComputerUseSession & { visionGranted: boolean },
    step: PlanStep,
  ): Promise<void> {
    const output = step.output || '';
    if (!output) return;

    // Try to discover a username from the read_screen output using common patterns
    const discoveries: Record<string, string> = {};

    // GitHub username patterns — ordered by reliability (most specific first).
    // OCR is noisy so we cast a wide net and validate later.
    const ghPatterns = [
      // Explicit "Signed in as" text
      /(?:Signed in as|signed in as)\s+([A-Za-z0-9_-]+)/i,
      // Profile URL in chrome context or OCR text (github.com/user or github.com/user?tab=...)
      /github\.com\/([A-Za-z0-9_-]{2,39})(?:\/|\?|$)/,
      // GitHub avatar / profile link alt text in page content
      /alt="@([A-Za-z0-9_-]+)"/i,
      // GitHub dashboard sidebar: username appears just before a dash or on its own line near "Home"
      /(?:search|to search)\s*\n?\s*([A-Za-z0-9_-]{2,39})\s*[-\n]/im,
      // GitHub header: username near avatar (OCR often reads it on a line by itself)
      /(?:Dashboard|Explore|Home)\s*\n?\s*([A-Za-z0-9_-]{2,39})\s*\n/im,
      // @username mention
      /@([A-Za-z0-9_-]+)/,
      // Username followed by contribution/repository context
      /(?:^|\n)\s*([A-Za-z0-9_-]+)\s*\n.*(?:repositor|contribution|follower)/im,
    ];
    for (const pat of ghPatterns) {
      const m = output.match(pat);
      if (m && m[1] && m[1].length >= 2 && m[1].length <= 39) {
        // Validate it looks like a real username (not a common word)
        const skipWords = new Set([
          'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
          'had', 'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how',
          'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did',
          'get', 'let', 'say', 'she', 'too', 'use', 'sign', 'login', 'page',
          'home', 'more', 'next', 'skip', 'back', 'help', 'menu', 'none',
          'signed', 'github', 'search', 'explore', 'repositories', 'stars',
        ]);
        if (!skipWords.has(m[1].toLowerCase())) {
          discoveries['USERNAME'] = m[1];
          break;
        }
      }
    }

    // Generic email extraction
    const emailMatch = output.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    if (emailMatch) {
      discoveries['EMAIL'] = emailMatch[1];
    }

    // ── LLM fallback: if regex failed to find USERNAME but plan needs it, ask LLM ──
    if (!discoveries['USERNAME']) {
      const needsUsername = session.plan.some(
        s => s.status === 'pending' && s.target && s.target.includes('__DISCOVERED_USERNAME__'),
      );
      if (needsUsername && output.length > 20) {
        try {
          const extractRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
            user_message:
              `Extract the logged-in username from this screen capture text. ` +
              `The text comes from OCR and may contain errors. ` +
              `Look for GitHub usernames, profile names, or account identifiers.\n\n` +
              `Screen text:\n${output.slice(0, 2000)}\n\n` +
              `Reply with ONLY the username (one word, no quotes, no explanation). ` +
              `If you cannot determine a username, reply with exactly: NONE`,
            context: { system_override: 'Extract the username. Reply with ONLY the username or NONE.', max_tokens: 50 },
          }, { timeout: 10000 });
          const extracted = (extractRes.data?.response_text || extractRes.data?.response || '').trim();
          if (extracted && extracted !== 'NONE' && extracted.length >= 2 && extracted.length <= 39 && /^[A-Za-z0-9_-]+$/.test(extracted)) {
            discoveries['USERNAME'] = extracted;
            this.logger.log(`LLM fallback discovered USERNAME: "${extracted}"`);
          }
        } catch (err: any) {
          this.logger.warn(`LLM username extraction failed: ${err.message}`);
        }
      }
    }

    if (Object.keys(discoveries).length === 0) return;

    // Store discoveries on the session for sub-step generation to use
    const existing = (session as any)._discoveries || {};
    Object.assign(existing, discoveries);
    (session as any)._discoveries = existing;

    this.logger.log(`Discovered values: ${JSON.stringify(discoveries)}`);

    // Replace __DISCOVERED_*__ tokens in all remaining pending steps
    let replacements = 0;
    for (const planStep of session.plan) {
      if (planStep.status !== 'pending' || !planStep.target) continue;

      let newTarget = planStep.target;
      for (const [key, value] of Object.entries(discoveries)) {
        const token = `__DISCOVERED_${key}__`;
        if (newTarget.includes(token)) {
          newTarget = newTarget.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
          replacements++;
        }
      }
      if (newTarget !== planStep.target) {
        this.logger.log(`Token replacement in step ${planStep.index + 1}: "${planStep.target}" → "${newTarget}"`);
        planStep.target = newTarget;
      }
    }

    if (replacements > 0) {
      this.logger.log(`Replaced ${replacements} discovery tokens in plan`);
    }
  }

  private async observeAndCheckProgress(
    sessionId: string,
    goal: string,
    plan: PlanStep[],
    currentStepIndex: number,
  ): Promise<boolean> {
    // Always get a FRESH screen image from the screen-share feed
    // Caller already waits for UI settle; just a brief pause for frame capture
    await new Promise(r => setTimeout(r, 500));
    const freshScreen = await this.getScreenImage(sessionId);
    if (!freshScreen) {
      this.logger.warn('No screen image for observation — skipping check');
      return false;
    }

    const currentStep = plan[currentStepIndex];
    const completedSummary = plan
      .filter((s, i) => i <= currentStepIndex && (s.status === 'completed' || s.status === 'running'))
      .map(s => `  Step ${s.index + 1} [${s.status}] "${s.action}": ${s.description}${s.output ? ` → ${s.output.slice(0, 100)}` : ''}`)
      .join('\n');
    const pendingSummary = plan
      .filter(s => s.status === 'pending')
      .map(s => `  Step ${s.index + 1} [pending] "${s.action}": ${s.description}`)
      .join('\n');

    const shareCtx = this.getShareContext(sessionId);

    const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
      user_message:
        `GOAL: ${goal}\n\n` +
        `SHARED SCREEN: ${shareCtx}\n\n` +
        `JUST EXECUTED (Step ${currentStepIndex + 1}): "${currentStep.action}" — ${currentStep.description}\n\n` +
        `ALL COMPLETED STEPS:\n${completedSummary || '  (none)'}\n\n` +
        `REMAINING STEPS:\n${pendingSummary || '  (none)'}\n\n` +
        `Look at the attached screenshot. This is what the screen looks like RIGHT NOW.\n\n` +
        `Question: Does the screen show a state consistent with Step ${currentStepIndex + 1} having succeeded?\n` +
        `- For "navigate to X": Is the page X visible on screen? If yes → on_track: true.\n` +
        `- For "click X": Did the expected UI change happen? If yes → on_track: true.\n` +
        `- For "type X": Is the typed text visible in the field? If yes → on_track: true.\n\n` +
        `If the screen ALREADY shows the desired result, that means the step worked. Report on_track: true.\n\n` +
        `Reply ONLY with JSON: {"on_track": true} or {"on_track": false, "reason": "brief description of what the screen actually shows instead"}`,
      context: {
        system_override:
          'You verify whether a computer-use step succeeded by looking at the screenshot. ' +
          'If the screen shows the expected outcome of the step, report on_track: true. ' +
          'Only report on_track: false if the screen clearly shows something WRONG (e.g., an error page, the wrong website, an unchanged state when a change was expected). ' +
          'Reply ONLY with valid JSON, nothing else.',
        screen_image: freshScreen,
        max_tokens: 200,
      },
    }, { timeout: LLM_TIMEOUT_MS });

    const text: string = res.data?.response_text || res.data?.response || '';
    this.logger.log(`Observation for step ${currentStepIndex + 1}: ${text.slice(0, 300)}`);

    try {
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.on_track === false) {
          this.logger.warn(`Step ${currentStepIndex + 1} failed observation: ${parsed.reason || 'unknown reason'}`);
          // Store the reason on the step for the revision prompt
          if (currentStep) {
            currentStep.output = (currentStep.output || '') + ` [OBSERVATION FAILED: ${parsed.reason || 'step did not achieve expected result'}]`;
          }
          return true;
        }
      }
    } catch {
      this.logger.warn('Observation JSON parse failed — assuming on track');
    }

    return false;
  }

  /**
   * Fetch screen geometry (position + size) for a specific display index.
   * Stores it on the session as _screen_region for use in screenshots and coordinate mapping.
   */
  private async fetchScreenGeometry(sessionId: string, screenIndex: number): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    try {
      const res = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/execute`,
        { tool: 'computer_action', action: 'list_screens' },
        { timeout: 10000 },
      );
      const screens = res.data?.screens || [];
      const target = screens[screenIndex];
      if (target) {
        (session as any)._screen_region = {
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
          index: screenIndex,
        };
        this.logger.log(
          `Screen ${screenIndex} geometry: (${target.x},${target.y}) ${target.width}x${target.height} "${target.name}"`,
        );
      } else {
        this.logger.warn(`Screen index ${screenIndex} not found (${screens.length} screens available)`);
      }
    } catch (err: any) {
      this.logger.warn(`fetchScreenGeometry failed: ${err.message}`);
    }
  }

  /**
   * Get the screen region for the session's capture target (if targeting a specific screen).
   */
  private getScreenRegion(sessionId: string): { x: number; y: number; width: number; height: number } | null {
    const session = sessions.get(sessionId);
    return (session as any)?._screen_region || null;
  }

  /**
   * Quick hash of a base64 screenshot string for dead-end detection.
   * Samples evenly-spaced chunks to avoid comparing full megabyte strings.
   * Not cryptographic — just enough to detect "screen didn't change at all".
   */
  private quickScreenHash(b64: string): string {
    if (!b64 || b64.length < 100) return b64 || '';
    const len = b64.length;
    // Sample 8 evenly-spaced 32-char chunks
    const samples: string[] = [];
    for (let i = 0; i < 8; i++) {
      const offset = Math.floor((len * i) / 8);
      samples.push(b64.substring(offset, offset + 32));
    }
    return samples.join('|') + `|${len}`;
  }

  /**
   * Ensure the target window is focused before performing actions.
   * Uses share_info (browser screen-share) or capture_target (native capture) to
   * determine which window/app to focus.
   * Returns the window bounds (for coordinate offset when targeting a window, not full screen).
   */
  private async focusSharedWindow(sessionId: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const session = sessions.get(sessionId);
    const shareInfo = (session as any)?._share_info as { displaySurface: string; label: string; sourceWidth: number; sourceHeight: number } | undefined;
    const captureTarget = (session as any)?._capture_target as { mode: string; target?: string } | undefined;

    // Determine the app to focus from share_info or capture_target
    let appName: string | null = null;
    let isFullScreen = false;

    if (shareInfo) {
      if (shareInfo.displaySurface === 'monitor') {
        isFullScreen = true;
      } else {
        appName = getAppNameFromLabel(shareInfo.label);
      }
    } else if (captureTarget) {
      if (captureTarget.mode === 'screen') {
        isFullScreen = true;
      } else if (captureTarget.mode === 'window' || captureTarget.mode === 'app') {
        appName = captureTarget.target || null;
      }
    }

    if (isFullScreen) {
      // For multi-screen: return the screen region as bounds so coordinates
      // are offset correctly (LLM sees only the target screen's image)
      const screenRegion = this.getScreenRegion(sessionId);
      if (screenRegion && (screenRegion.x !== 0 || screenRegion.y !== 0)) {
        this.logger.log(`Full screen mode — screen offset: (${screenRegion.x},${screenRegion.y}) ${screenRegion.width}x${screenRegion.height}`);
        return screenRegion;
      }
      this.logger.log('Full screen mode — primary screen, no offset needed');
      return null;
    }

    if (!appName) {
      this.logger.warn(`No target app for session ${sessionId} — cannot focus window`);
      return null;
    }

    this.logger.log(`Focusing target app: "${appName}"`);

    // Focus the window/app and get bounds in one flow
    try {
      await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/execute`,
        { tool: 'computer_action', action: 'focus_window', text: appName },
        { timeout: 5000 },
      );
    } catch (err: any) {
      this.logger.warn(`Failed to focus "${appName}": ${err.message}`);
    }

    // Get bounds for coordinate offset
    try {
      const boundsRes = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/execute`,
        { tool: 'computer_action', action: 'get_window_bounds', text: appName },
        { timeout: 5000 },
      );
      if (boundsRes.data?.bounds) {
        this.logger.log(`Window bounds: ${JSON.stringify(boundsRes.data.bounds)}`);
        return boundsRes.data.bounds;
      }
    } catch { /* use null — no offset */ }

    return null;
  }

  /**
   * Use the vision LLM to find click coordinates for a target element on screen.
   * Returns {x, y} in screen pixels, or null if the element can't be found.
   */
  /**
   * Get the latest screen image for a session.
   * Primary source: native screenshot via OasisScreenCapture.app (through dev-agent).
   * Supports capture_target for window/app-specific screenshots.
   * Falls back to browser screen-share frame if available.
   */
  private async getScreenImage(sessionId: string): Promise<string | undefined> {
    const session = sessions.get(sessionId);
    const captureTarget = (session as any)?._capture_target as { mode: string; target?: string } | undefined;

    // 1. Primary: native screenshot via dev-agent (OasisScreenCapture.app)
    try {
      // If targeting a specific window/app, focus it first then capture its region
      if (captureTarget?.target && (captureTarget.mode === 'window' || captureTarget.mode === 'app')) {
        await axios.post(
          `${DEV_AGENT_URL}/internal/dev-agent/execute`,
          { tool: 'computer_action', action: 'focus_window', text: captureTarget.target },
          { timeout: 5000 },
        ).catch(() => { /* best effort focus */ });
        await new Promise(r => setTimeout(r, 300));
      }

      // If targeting a specific screen, pass the screen region for cropped capture
      const screenRegion = this.getScreenRegion(sessionId);
      const payload: Record<string, any> = { tool: 'computer_action', action: 'screenshot' };
      if (screenRegion) {
        payload.screen_region = screenRegion;
      }

      const res = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/execute`,
        payload,
        { timeout: ACTION_TIMEOUT_MS },
      );
      if (res.data?.screenshot) {
        // Validate screenshot isn't blank/black (Screen Recording permission missing).
        // A real 1024px screenshot is typically >20KB base64. A blank JPEG is <15KB.
        const b64Len = res.data.screenshot.length;
        if (b64Len > 20_000) {
          this.logger.log(`Native screenshot captured (${b64Len} chars, target: ${captureTarget?.mode || 'full_screen'}${screenRegion ? ` screen@${screenRegion.x},${screenRegion.y}` : ''})`);
          return res.data.screenshot;
        }
        this.logger.warn(`Native screenshot appears blank (${b64Len} chars) — Screen Recording permission may not be granted to OasisScreenCapture.app`);
      }
    } catch { /* native capture not available — fall through */ }

    // 2. Fallback: browser screen-share frame (if the user opted into browser sharing)
    const frameAge = Date.now() - ((session as any)?._screen_frame_at || 0);
    if (session?.live_screenshot) {
      if (frameAge < 10000) {
        this.logger.log(`Using browser screen-share frame (${frameAge}ms old)`);
      } else {
        this.logger.warn(`Using stale screen-share frame (${frameAge}ms old) — native capture unavailable`);
      }
      return session.live_screenshot;
    }

    return undefined;
  }

  /**
   * Use the vision LLM to find click coordinates for a target element.
   * The image is typically 1280px wide (screen-share capture).
   * We need to scale coordinates to actual screen resolution.
   */
  /**
   * Get native image dimensions and scale factor for coordinate mapping.
   *
   * The screen-share capture is max 1280px wide. We need to scale coordinates
   * from image-space back to the WINDOW's native size (CSS pixels / points).
   */
  private async getImageScale(sessionId?: string): Promise<{ nativeWidth: number; imageWidth: number; scale: number }> {
    let nativeWidth = 1024;
    if (sessionId) {
      const session = sessions.get(sessionId);

      // Priority 1: target screen region (native capture of a specific screen)
      const screenRegion = (session as any)?._screen_region as { width: number; height: number } | undefined;
      if (screenRegion?.width && screenRegion.width > 0) {
        nativeWidth = screenRegion.width;
        this.logger.log(`Using screen_region.width=${nativeWidth} for coordinate scaling`);
      }

      // Priority 2: browser share info
      if (nativeWidth === 1024) {
        const shareInfo = (session as any)?._share_info as { sourceWidth: number; sourceHeight: number } | undefined;
        if (shareInfo?.sourceWidth && shareInfo.sourceWidth > 0) {
          nativeWidth = shareInfo.sourceWidth;
          this.logger.log(`Using shareInfo.sourceWidth=${nativeWidth} for coordinate scaling`);
        }
      }
    }
    if (nativeWidth === 1024) {
      try {
        const sizeRes = await axios.post(
          `${DEV_AGENT_URL}/internal/dev-agent/execute`,
          { tool: 'computer_action', action: 'get_screen_size' },
          { timeout: 5000 },
        );
        const sizeMatch = sizeRes.data?.output?.match(/(\d+)x(\d+)/);
        if (sizeMatch) nativeWidth = parseInt(sizeMatch[1], 10);
      } catch { /* use defaults */ }
    }
    const imageWidth = Math.min(nativeWidth, 1024);
    return { nativeWidth, imageWidth, scale: nativeWidth / imageWidth };
  }

  /**
   * Try to find a UI element via the UI Parser service (fast, deterministic).
   *
   * If the UI parser is available and has detection+OCR results, we can match
   * elements by text/type without an LLM call. Returns pixel coordinates in
   * image-space, or null if the parser isn't available or can't find the element.
   */
  private async resolveViaUIParser(
    target: string,
    sessionId?: string,
  ): Promise<{ x: number; y: number } | null> {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const uiParseCache = (session as any)?._ui_parse_cache as Array<{
      type: string; bbox_px: number[]; text: string; confidence: number;
    }> | undefined;

    if (!uiParseCache || uiParseCache.length === 0) return null;

    const targetLower = target.toLowerCase().trim();

    // 1. Exact text match
    let match = uiParseCache.find(c =>
      c.text && c.text.toLowerCase().trim() === targetLower,
    );

    // 2. Text contains target
    if (!match) {
      match = uiParseCache.find(c =>
        c.text && c.text.toLowerCase().includes(targetLower),
      );
    }

    // 3. Target contains component text (e.g., target="click the Login button", text="Login")
    if (!match) {
      match = uiParseCache.find(c =>
        c.text && c.text.length > 1 && targetLower.includes(c.text.toLowerCase()),
      );
    }

    // 4. Type-based match (e.g., target="search input", type="input")
    if (!match) {
      for (const hint of ['button', 'input', 'icon']) {
        if (targetLower.includes(hint)) {
          match = uiParseCache.find(c => c.type === hint);
          if (match) break;
        }
      }
    }

    if (!match) return null;

    const [x1, y1, x2, y2] = match.bbox_px;
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    this.logger.log(
      `UI Parser match for "${target}": "${match.text}" (${match.type}) at center (${cx},${cy})`,
    );
    return { x: cx, y: cy };
  }

  /**
   * Run the UI parser on the current screen image and cache results on the session.
   *
   * Calls the parse-screen endpoint which:
   *   1. Runs Tesseract OCR on the screenshot (extracts text regions)
   *   2. Combines with any YOLO detections (if provided externally)
   *   3. Returns classified UI components with pixel bboxes
   *
   * If the parser service isn't available, this is a no-op — the LLM vision fallback
   * handles everything. Called once per high-level step (not per sub-step).
   */
  private async updateUIParseCache(sessionId: string, screenImageB64: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    try {
      const { imageWidth } = await this.getImageScale(sessionId);
      const shareInfo = (session as any)?._share_info as { sourceHeight?: number } | undefined;
      const imageHeight = shareInfo?.sourceHeight
        ? Math.min(shareInfo.sourceHeight, Math.round(imageWidth * (shareInfo.sourceHeight / (shareInfo as any).sourceWidth || 0.625)))
        : Math.round(imageWidth * 0.625);

      // Send the raw screenshot — the UI parser runs OCR + classification internally
      const res = await axios.post(`${UI_PARSER_URL}/internal/ui-parser/parse-screen`, {
        image: screenImageB64,
        image_width: imageWidth,
        image_height: imageHeight,
        detections: (session as any)._ui_detections || [],
      }, { timeout: 10_000 }); // OCR can take a few seconds

      if (res.data?.components) {
        (session as any)._ui_parse_cache = res.data.components;
        this.logger.log(
          `UI parse cache updated: ${res.data.components.length} components, ` +
          `${res.data.ocr_results?.length || 0} OCR regions`,
        );
      }
    } catch (err: any) {
      // UI parser not available — this is fine, LLM vision fallback handles it
      this.logger.debug(`UI parser unavailable (expected if not running): ${err.message}`);
    }
  }

  /**
   * Resolve the pixel coordinates of a UI element on screen.
   *
   * Strategy (fast & accurate → slow fallback):
   *   1. UI Parser grounding: OCR text matching (<0.2s) + GroundingDINO (~2s for visual elements)
   *   2. LLM Vision grid-based (slower, ~2s, less accurate) — only if grounding fails
   *
   * Returns coordinates in NATIVE pixel space (ready for pyautogui).
   * The caller adds screen origin offset for absolute positioning.
   */
  private async resolveClickCoordinates(
    target: string,
    screenImageB64: string,
    sessionId?: string,
  ): Promise<{ x: number; y: number } | null> {
    const { nativeWidth, imageWidth, scale } = await this.getImageScale(sessionId);
    const imageHeight = Math.round(imageWidth * 0.5625);

    // ── Strategy 1: Florence-2 grounding (pixel-accurate) ──
    try {
      const groundRes = await axios.post(`${UI_PARSER_URL}/internal/ui-parser/ground`, {
        image: screenImageB64,
        query: target,
        image_width: imageWidth,
        image_height: imageHeight,
      }, { timeout: 15_000 });

      const detections = groundRes.data?.detections;
      if (detections && detections.length > 0) {
        // Pick the first (highest confidence) detection
        const best = detections[0];
        const cx = best.center[0];
        const cy = best.center[1];

        // Florence-2 returns coordinates in image space — scale to native
        const nativeX = Math.round(cx * scale);
        const nativeY = Math.round(cy * scale);

        this.logger.log(
          `[UI Parser Ground] "${target}": image(${cx},${cy}) → native(${nativeX},${nativeY}) ` +
          `bbox=[${best.bbox.join(',')}] scale=${scale.toFixed(2)} (${detections.length} matches)`,
        );
        return { x: nativeX, y: nativeY };
      }
      this.logger.log(`[UI Parser Ground] No matches for "${target}" — falling back to vision LLM`);
    } catch (err: any) {
      this.logger.warn(`[UI Parser Ground] Unavailable: ${err.message} — falling back to vision LLM`);
    }

    // ── Strategy 2: Vision LLM grid-based (fallback) ──
    const pass1 = await this.visionLocateElement(target, screenImageB64, imageWidth, imageHeight);
    if (!pass1) return null;

    // ── Pass 2: zoom refinement on the LLM result ──
    try {
      const cropHalfNative = 200;
      const screenOffset = this.getScreenRegion(sessionId || '');
      const baseX = (screenOffset?.x || 0);
      const baseY = (screenOffset?.y || 0);

      const nativeCX = Math.round(pass1.x * scale);
      const nativeCY = Math.round(pass1.y * scale);

      const cropX1 = Math.max(0, nativeCX - cropHalfNative);
      const cropY1 = Math.max(0, nativeCY - cropHalfNative);
      const cropW = Math.min(nativeWidth - cropX1, cropHalfNative * 2);
      const cropH = Math.min(Math.round(nativeWidth * 0.5625) - cropY1, cropHalfNative * 2);

      if (cropW > 100 && cropH > 100) {
        const cropRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
          tool: 'computer_action',
          action: 'screenshot',
          screen_region: {
            x: baseX + cropX1,
            y: baseY + cropY1,
            width: cropW,
            height: cropH,
          },
        }, { timeout: ACTION_TIMEOUT_MS });

        const croppedB64 = cropRes.data?.screenshot;
        if (croppedB64) {
          const pass2 = await this.visionLocateElement(target, croppedB64, cropW, cropH);
          if (pass2) {
            const refinedX = cropX1 + pass2.x;
            const refinedY = cropY1 + pass2.y;
            this.logger.log(
              `[Zoom Refine] "${target}": pass1 native(${nativeCX},${nativeCY}) → crop(${pass2.x},${pass2.y}) → refined(${refinedX},${refinedY})`,
            );
            return { x: refinedX, y: refinedY };
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`[Zoom Refine] Failed, using pass-1 result: ${err.message}`);
    }

    // Fall back to pass-1 (scaled to native)
    const scaledX = Math.round(pass1.x * scale);
    const scaledY = Math.round(pass1.y * scale);
    this.logger.log(
      `[Vision LLM Pass 1] "${target}": image(${pass1.x},${pass1.y}) → native(${scaledX},${scaledY}) ` +
      `scale=${scale.toFixed(2)}`,
    );
    return { x: scaledX, y: scaledY };
  }

  /**
   * Ask the vision LLM to locate an element in a screenshot.
   * Returns coordinates in the IMAGE's pixel space (not scaled to native).
   *
   * Uses a grid-overlay approach: divides the image into a 10x10 grid and asks
   * the LLM to identify which grid cell, then refine within that cell.
   * This is much more accurate than asking for raw pixel coordinates.
   */
  private async visionLocateElement(
    target: string,
    imageB64: string,
    imageWidth: number,
    imageHeight: number,
  ): Promise<{ x: number; y: number } | null> {
    const gridCols = 10;
    const gridRows = 10;
    const cellW = Math.round(imageWidth / gridCols);
    const cellH = Math.round(imageHeight / gridRows);

    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message:
          `You are looking at a screenshot (${imageWidth}x${imageHeight} pixels).\n` +
          `Imagine the image is divided into a ${gridCols}x${gridRows} grid.\n` +
          `Each cell is ${cellW}x${cellH} pixels. Columns are labeled 0-${gridCols - 1} (left to right), rows 0-${gridRows - 1} (top to bottom).\n\n` +
          `Find: "${target}"\n\n` +
          `Which grid cell (col, row) contains this element? Then compute pixel coordinates.\n` +
          `Cell center formula: x = ${cellW}*col + ${Math.round(cellW / 2)}, y = ${cellH}*row + ${Math.round(cellH / 2)}\n\n` +
          `Reply with ONLY a JSON object: {"col": <int>, "row": <int>, "x": <int>, "y": <int>}\n` +
          `If not visible: {"error": "not found"}`,
        context: {
          system_override:
            'You locate UI elements in screenshots. Output ONLY JSON, no reasoning. ' +
            'Grid: col 0-9 left-to-right, row 0-9 top-to-bottom. (0,0) is top-left. ' +
            'Nav bar: row 0. Sidebar: col 0-2. Main content: col 2-8. Profile avatar: col 9, row 0. ' +
            'Output ONLY the JSON object. Nothing else.',
          screen_image: imageB64,
          max_tokens: 100,
        },
      }, { timeout: LLM_TIMEOUT_MS });

      const text: string = res.data?.response_text || res.data?.response || '';
      this.logger.log(`[Vision Locate] "${target}": ${text.slice(0, 400)}`);

      // Find the last JSON object in the response (chain-of-thought precedes it)
      const jsonMatches = text.match(/\{[^{}]*\}/g);
      const jsonStr = jsonMatches ? jsonMatches[jsonMatches.length - 1] : null;
      if (!jsonStr) return null;

      const parsed = JSON.parse(jsonStr);
      if (parsed.error) {
        this.logger.warn(`Element "${target}" not found: ${parsed.error}`);
        return null;
      }

      // If the LLM returned x,y directly, use them
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        // Sanity check: coordinates must be within image bounds
        const x = Math.max(0, Math.min(parsed.x, imageWidth - 1));
        const y = Math.max(0, Math.min(parsed.y, imageHeight - 1));
        this.logger.log(`[Vision Locate] "${target}": (${x}, ${y}) [grid col=${parsed.col}, row=${parsed.row}]`);
        return { x, y };
      }

      // If only col/row provided, compute center of that grid cell
      if (typeof parsed.col === 'number' && typeof parsed.row === 'number') {
        const x = Math.round(cellW * parsed.col + cellW / 2);
        const y = Math.round(cellH * parsed.row + cellH / 2);
        this.logger.log(`[Vision Locate] "${target}": grid(${parsed.col},${parsed.row}) → (${x}, ${y})`);
        return { x: Math.max(0, Math.min(x, imageWidth - 1)), y: Math.max(0, Math.min(y, imageHeight - 1)) };
      }

      return null;
    } catch (err: any) {
      this.logger.error(`visionLocateElement failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Move the mouse to the center of the shared window (mouse_move, NOT click).
   * This ensures the pointer is visible inside the shared window and keyboard
   * events go to the correct window, especially on multi-monitor setups.
   */
  private async ensureMouseInWindow(
    windowBounds: { x: number; y: number; width: number; height: number } | null,
  ): Promise<void> {
    if (!windowBounds) return;
    const centerX = windowBounds.x + Math.round(windowBounds.width / 2);
    const centerY = windowBounds.y + Math.round(windowBounds.height / 2);
    try {
      // Move the mouse (not click) — just park the pointer inside the shared window
      await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/execute`,
        { tool: 'computer_action', action: 'mouse_move', x: centerX, y: centerY, duration: 0.15 },
        { timeout: ACTION_TIMEOUT_MS },
      );
      this.logger.log(`Moved mouse to window center (${centerX},${centerY})`);
      await new Promise(r => setTimeout(r, 100));
    } catch (err: any) {
      this.logger.warn(`ensureMouseInWindow failed: ${err.message}`);
    }
  }

  /**
   * Execute a single plan step via the dev-agent's computer_action tool.
   * Maps plan actions → real pyautogui actions on the host.
   *
   * CRITICAL: On multi-monitor setups, the shared window may be on a secondary display.
   * All coordinates must be absolute (including monitor offset from window bounds).
   * Keyboard actions require the mouse to be inside the correct window first.
   */
  private async executeComputerAction(
    step: PlanStep,
    sessionId?: string,
  ): Promise<{ output: string; screenshot?: string }> {
    const action = step.action.toLowerCase();
    const target = step.target || '';
    const sid = sessionId || '';

    // For observation-only actions, no need to focus
    if (action === 'screenshot') {
      const img = await this.getScreenImage(sid);
      return { output: 'Screen captured', screenshot: img };
    }

    // read_screen: extract text from page via Chrome AppleScript (reliable), fall back to vision LLM
    if (action === 'read_screen' || action === 'read_page' || action === 'extract_text') {
      const img = await this.getScreenImage(sid);

      // Step 1: Get Chrome URL/title context (fast, always works)
      const session3 = sessions.get(sid);
      const workUrlHint = (session3 as any)?._work_url_hint || '';
      let chromeContext = '';
      try {
        const pageRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
          tool: 'computer_action',
          action: 'get_page_text',
          text: workUrlHint,
        }, { timeout: 15000 });
        if (pageRes.data?.success && pageRes.data.output) {
          const raw = pageRes.data.output as string;
          // Check if JS extraction returned actual page content
          const contentIdx = raw.indexOf('Page content:\n');
          if (contentIdx >= 0) {
            const pageContent = raw.slice(contentIdx + 'Page content:\n'.length).trim();
            if (pageContent.length > 50) {
              // JS extraction worked — we have real page content
              this.logger.log(`read_screen via get_page_text+JS: ${raw.length} chars (content: ${pageContent.length} chars)`);
              return { output: raw, screenshot: img };
            }
          }
          // JS extraction didn't work — keep URL/title for context
          chromeContext = raw.split('\n\nPage content:')[0];
          this.logger.log(`read_screen: got Chrome URL/title (${chromeContext.length} chars) but no JS content`);
        }
      } catch (err: any) {
        this.logger.warn(`get_page_text failed: ${err.message}`);
      }

      // Step 2: Native macOS Vision OCR via dev-agent (fast, accurate, no API calls)
      // This runs locally using macOS Vision framework — no vendor lock-in.
      try {
        const screenRegion = this.getScreenRegion(sid);
        const ocrPayload: Record<string, any> = { tool: 'computer_action', action: 'ocr_screenshot' };
        if (screenRegion) ocrPayload.screen_region = screenRegion;
        const ocrRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
          ocrPayload, { timeout: 30000 });
        if (ocrRes.data?.success && ocrRes.data.output) {
          const ocrText = ocrRes.data.output as string;
          if (ocrText.length > 50) {
            const fullOutput = chromeContext ? `${chromeContext}\n\nVisible text (OCR):\n${ocrText}` : ocrText;
            this.logger.log(`read_screen via native OCR: ${ocrText.length} chars`);
            // Update screenshot from OCR result if available
            if (ocrRes.data.screenshot && session3) session3.live_screenshot = ocrRes.data.screenshot;
            return { output: fullOutput, screenshot: ocrRes.data.screenshot || img };
          }
        }
      } catch (err: any) {
        this.logger.warn(`Native OCR failed: ${err.message} — falling through`);
      }

      // Step 3: Return Chrome context + whatever screenshot we have
      // (Vision LLM fallback removed — unreliable with most OpenAI-compatible gateways)
      return { output: chromeContext || 'Screen captured (text extraction not available)', screenshot: img };
    }
    if (action === 'wait') {
      await new Promise(r => setTimeout(r, 1000));
      const waitScreen = await this.getScreenImage(sid);
      return { output: 'Waited 1 second', screenshot: waitScreen };
    }

    // Focus the shared window AND get its absolute screen position (includes monitor offset)
    const windowBounds = await this.focusSharedWindow(sid);
    if (windowBounds) {
      this.logger.log(`Window at absolute position: (${windowBounds.x},${windowBounds.y}) size ${windowBounds.width}x${windowBounds.height}`);
    }

    // ALWAYS move the mouse into the shared window before any interactive action.
    // This ensures (a) the correct window has input focus, (b) the pointer is visible on the shared screen.
    await this.ensureMouseInWindow(windowBounds);

    switch (action) {
      case 'navigate': {
        const url = target.startsWith('http') ? target : `https://${target}`;
        this.logger.log(`Navigate: ${url}`);

        const session2 = sessions.get(sid);
        const alreadyOpened = !!(session2 as any)?._work_window_opened;
        const screenRegion = this.getScreenRegion(sid);

        if (!alreadyOpened) {
          // FIRST navigate: always create a new Chrome window via AppleScript.
          // This avoids navigating the wrong window (e.g. Oasis UI at localhost:3000).
          try {
            const payload: Record<string, any> = {
              tool: 'computer_action', action: 'chrome_navigate', text: url,
            };
            if (screenRegion) {
              payload.x = screenRegion.x;
              payload.y = screenRegion.y;
              payload.screen_region = { ...screenRegion };
            }
            const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
              payload, { timeout: 15000 });
            this.logger.log(`chrome_navigate (new window): ${res.data?.output}`);
          } catch (err: any) {
            this.logger.warn(`chrome_navigate failed, falling back to focus+Cmd+L: ${err.message}`);
            // Fallback: focus Chrome and type URL
            try {
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'focus_window', text: 'Google Chrome' },
                { timeout: 5000 });
              await new Promise(r => setTimeout(r, 200));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'hotkey', keys: [hostModifier(), 'l'] },
                { timeout: ACTION_TIMEOUT_MS });
              await new Promise(r => setTimeout(r, 300));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'type_text', text: url },
                { timeout: ACTION_TIMEOUT_MS });
              await new Promise(r => setTimeout(r, 300));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'key_press', key: 'enter' },
                { timeout: ACTION_TIMEOUT_MS });
            } catch { /* best effort */ }
          }
          if (session2) {
            (session2 as any)._work_window_opened = true;
            // Track the URL domain so get_page_text can find the right window
            try { (session2 as any)._work_url_hint = new URL(url).hostname; } catch { /* ignore */ }
          }
        } else {
          // Subsequent navigates: use AppleScript to set URL in the work window.
          // This avoids Cmd+L which might hit the wrong Chrome window.
          // Find the work window by URL hint, then set its active tab URL.
          const workHint = (session2 as any)?._work_url_hint || '';
          try {
            await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action',
              action: 'chrome_set_url',
              text: url,
              url_hint: workHint,
            }, { timeout: 15000 });
            this.logger.log(`chrome_set_url: navigated work window to ${url}`);
          } catch (err: any) {
            this.logger.warn(`chrome_set_url failed, falling back to focus+Cmd+L: ${err.message}`);
            // Fallback: focus Chrome and type URL
            try {
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'focus_window', text: 'Google Chrome' },
                { timeout: 5000 });
              await new Promise(r => setTimeout(r, 200));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'hotkey', keys: [hostModifier(), 'l'] },
                { timeout: ACTION_TIMEOUT_MS });
              await new Promise(r => setTimeout(r, 300));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'type_text', text: url },
                { timeout: ACTION_TIMEOUT_MS });
              await new Promise(r => setTimeout(r, 300));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
                { tool: 'computer_action', action: 'key_press', key: 'enter' },
                { timeout: ACTION_TIMEOUT_MS });
            } catch { /* best effort */ }
          }

          // Update work URL hint — use path portion for more specific matching
          if (session2) {
            try {
              const parsed = new URL(url);
              (session2 as any)._work_url_hint = parsed.hostname + parsed.pathname;
            } catch { /* ignore */ }
          }
        }

        await new Promise(r => setTimeout(r, 2500));
        const navScreen = await this.getScreenImage(sid);
        return { output: `Navigated to ${url}`, screenshot: navScreen };
      }

      case 'click': {
        const screenB64 = await this.getScreenImage(sid);
        if (!screenB64) {
          return { output: `Click failed: no screen image available to locate "${target}"` };
        }

        const coords = await this.resolveClickCoordinates(target, screenB64, sid);
        if (!coords) {
          return { output: `Could not locate "${target}" on screen`, screenshot: screenB64 };
        }

        // The vision model returns coordinates WITHIN the captured image.
        // The image shows only the shared window content.
        // We must offset to the window's absolute position on screen (multi-monitor).
        let clickX = coords.x;
        let clickY = coords.y;
        if (windowBounds) {
          clickX += windowBounds.x;
          clickY += windowBounds.y;
          this.logger.log(`Click offset: image(${coords.x},${coords.y}) + window(${windowBounds.x},${windowBounds.y}) = screen(${clickX},${clickY})`);
        }

        this.logger.log(`Clicking "${target}" at absolute (${clickX}, ${clickY})`);
        const clickRes = await axios.post(
          `${DEV_AGENT_URL}/internal/dev-agent/execute`,
          { tool: 'computer_action', action: 'click', x: clickX, y: clickY },
          { timeout: ACTION_TIMEOUT_MS },
        );

        await new Promise(r => setTimeout(r, 500));
        const postClickScreen = await this.getScreenImage(sid);
        return {
          output: clickRes.data?.output || `Clicked "${target}" at (${clickX}, ${clickY})`,
          screenshot: postClickScreen || clickRes.data?.screenshot,
        };
      }

      case 'type': {
        if (!target) return { output: 'type action requires target text' };
        // Single call — errors propagate to sub-step retry mechanism.
        await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
          { tool: 'computer_action', action: 'type_text', text: target },
          { timeout: ACTION_TIMEOUT_MS });
        await new Promise(r => setTimeout(r, 300));
        const typeScreen = await this.getScreenImage(sid);
        return { output: `Typed: ${target.slice(0, 80)}`, screenshot: typeScreen };
      }

      case 'key_press': {
        if (!target) return { output: 'key_press action requires target key name' };
        const payload: Record<string, any> = { tool: 'computer_action' };
        if (target.includes('+')) {
          payload.action = 'hotkey';
          payload.keys = target.split('+').map(k => k.trim());
        } else {
          payload.action = 'key_press';
          payload.key = target;
        }
        await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, payload, { timeout: ACTION_TIMEOUT_MS });
        await new Promise(r => setTimeout(r, 300));
        const keyScreen = await this.getScreenImage(sid);
        return { output: `Pressed: ${target}`, screenshot: keyScreen };
      }

      case 'scroll': {
        const scrollPayload: Record<string, any> = {
          tool: 'computer_action',
          action: 'scroll',
          direction: target.toLowerCase() === 'up' ? 'up' : 'down',
          amount: 5,
        };
        if (windowBounds) {
          scrollPayload.x = windowBounds.x + Math.round(windowBounds.width / 2);
          scrollPayload.y = windowBounds.y + Math.round(windowBounds.height / 2);
        }
        await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, scrollPayload, { timeout: ACTION_TIMEOUT_MS });
        await new Promise(r => setTimeout(r, 300));
        const scrollScreen = await this.getScreenImage(sid);
        return { output: `Scrolled ${target || 'down'}`, screenshot: scrollScreen };
      }

      default: {
        this.logger.warn(`Unknown plan action "${action}" — capturing screen`);
        const fallbackScreen = await this.getScreenImage(sid);
        return { output: `Unknown action: ${action}`, screenshot: fallbackScreen };
      }
    }
  }
}
