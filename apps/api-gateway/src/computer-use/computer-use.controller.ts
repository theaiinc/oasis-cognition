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
  type OnModuleInit,
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
import { SessionMemory, listStoredSessions, loadSessionFromDisk, promoteSessionToArtifacts } from './session-memory';
import { matchSkills, planGuidanceFor, reactGuidanceFor } from './skills';

const RESPONSE_URL = process.env.RESPONSE_URL || 'http://localhost:8005';
const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const UI_PARSER_URL = process.env.UI_PARSER_URL || 'http://localhost:8011';
const TOOL_EXECUTOR_URL = process.env.TOOL_EXECUTOR_URL || 'http://localhost:8007';
const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';
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
    const { platform } = await new (await import('./local-macos-runtime')).LocalMacOSRuntime(DEV_AGENT_URL).health();
    if (platform === 'darwin' || platform === 'linux' || platform === 'windows') HOST_PLATFORM = platform;
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

import { Inject } from '@nestjs/common';
import type { ComputerUseRuntime } from './computer-use-runtime.interface';
import { ComputerUseRuntimeToken } from './computer-use-runtime.interface';

@Controller('computer-use')
export class ComputerUseController implements OnModuleInit {
  private readonly logger = new Logger(ComputerUseController.name);

  constructor(
    @Inject(ComputerUseRuntimeToken) private readonly runtime: ComputerUseRuntime,
  ) {}

  /* ──────────────────────────── Durable memory ────────────────────────── */

  /** Persist session to disk via SessionMemory. Fire-and-forget. */
  private persistSession(session: ComputerUseSession): void {
    const mem = new SessionMemory(session.session_id);
    mem.snapshot(session).catch(err => {
      this.logger.debug(`SessionMemory snapshot failed for ${session.session_id}: ${err.message}`);
    });
  }

  /** Persist a single step's FULL output to disk. Fire-and-forget.
   *  Files: ~/.oasis/cu-sessions/<sid>/memory/NNN-action.md */
  private persistStep(sessionId: string, step: PlanStep, extra: { thought?: string; before?: string } = {}): void {
    const mem = new SessionMemory(sessionId);
    mem.writeStep(step, extra).catch(err => {
      this.logger.debug(`SessionMemory writeStep failed for ${sessionId} step ${step.index}: ${err.message}`);
    });
  }

  /** Append a concrete fact to MEMORY.md. Fire-and-forget. */
  private recordFact(sessionId: string, fact: string): void {
    const mem = new SessionMemory(sessionId);
    mem.addFact(fact).catch(() => {});
  }

  /** Load all CU sessions from disk on startup. Re-adds them to the in-memory Map.
   *  Phase 8: Resume any sessions that were mid-execution when the gateway died. */
  async onModuleInit(): Promise<void> {
    try {
      const ids = await listStoredSessions();
      if (ids.length === 0) return;
      let loaded = 0;
      let resumed = 0;
      for (const id of ids) {
        if (sessions.has(id)) continue;
        const s = await loadSessionFromDisk(id);
        if (!s) continue;
        // Ensure required runtime fields are set
        const hydrated = { visionGranted: false, ...s } as ComputerUseSession & { visionGranted: boolean };
        sessions.set(id, hydrated);
        loaded++;

        // Phase 8: Resume sessions that were actively executing when gateway died.
        // We DON'T auto-resume click-assist/paused (user-initiated states) — user must explicitly resume.
        if (hydrated.status === 'executing' && hydrated.visionGranted) {
          this.logger.log(`Auto-resuming interrupted session ${id} at step ${hydrated.current_step + 1}/${hydrated.plan.length}`);
          // Mark that we interrupted so the agent knows
          const mem = new SessionMemory(id);
          mem.write('USER_NOTES.md',
            `- [${new Date().toISOString()}] Session was interrupted (gateway restart). Resumed from step ${hydrated.current_step + 1}. Re-read the screen before continuing.\n`,
            true,
          ).catch(() => {});
          this.executeAdaptiveLoop(id).catch(err => {
            this.logger.warn(`Auto-resume failed for ${id}: ${err.message}`);
          });
          resumed++;
        }
      }
      this.logger.log(`Rehydrated ${loaded} CU session(s) from disk (auto-resumed ${resumed})`);
    } catch (err: any) {
      this.logger.warn(`Failed to rehydrate sessions from disk: ${err.message}`);
    }
  }

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
    // Return any non-terminal session first (executing, planning, awaiting_approval, paused)
    const active = [...sessions.values()]
      .filter(s => !['completed', 'failed', 'cancelled'].includes(s.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (active.length > 0) {
      const { live_screenshot, ...rest } = active[0];
      return { session: rest };
    }

    // If no active session, return the most recently completed/failed one
    // (within 5 minutes) so the overlay keeps showing the result
    const recent = [...sessions.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (recent.length > 0) {
      const latest = recent[0];
      const age = Date.now() - new Date(latest.updated_at).getTime();
      if (age < 300_000) { // 5 minutes
        const { live_screenshot, ...rest } = latest;
        return { session: rest };
      }
    }

    return { session: null };
  }

  /** Get a single session (includes live screenshot). */
  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    const s = sessions.get(id);
    if (!s) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    return s;
  }

  /** Phase 6: Session memory inspection — lists files stored on disk. */
  @Get('sessions/:id/memory')
  async getSessionMemory(@Param('id') id: string) {
    const mem = new SessionMemory(id);
    const [rootFiles, stepFiles, memoryMd, scratchMd, userNotesMd, handoff] = await Promise.all([
      mem.list(''),
      mem.list('memory'),
      mem.read('MEMORY.md'),
      mem.read('SCRATCH.md'),
      mem.read('USER_NOTES.md'),
      mem.read('HANDOFF.md'),
    ]);
    return {
      session_id: id,
      memory: memoryMd,
      scratch: scratchMd,
      user_notes: userNotesMd,
      handoff,
      steps: stepFiles
        .filter(f => !f.is_dir && f.name.endsWith('.md'))
        .map(f => ({ name: f.name, size: f.size })),
      files: rootFiles.map(f => ({ name: f.name, is_dir: f.is_dir, size: f.size })),
    };
  }

  /** Phase 6: Read a specific memory file (step, handoff, etc). */
  @Get('sessions/:id/memory/:path')
  async getSessionMemoryFile(@Param('id') id: string, @Param('path') path: string) {
    // Basic path sanitization — only allow known file patterns
    if (!/^[A-Za-z0-9_\-./]+\.md$/.test(path)) {
      throw new HttpException('Invalid path', HttpStatus.BAD_REQUEST);
    }
    const mem = new SessionMemory(id);
    const content = await mem.read(path);
    return { session_id: id, path, content };
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

    // Clean up voice transcription — remove filler words, false starts, and normalize
    let cleanGoal = dto.goal.trim();
    // Always clean up CU goals — voice transcriptions often have misheard words,
    // filler words, false starts, and unclear phrasing that confuse the planner.
    // The LLM cleanup is fast (<2s) and only improves quality.
    const needsCleanup = cleanGoal.length > 20; // Skip trivially short goals
    if (needsCleanup) {
      try {
        const cleanupRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
          user_message:
            `Clean up this task description. Be CONSERVATIVE — only fix obvious issues:\n` +
            `- Fix encoding/diacritic errors (e.g., "ưhen" → "when", "réume" → "resume", "ủe" → "user")\n` +
            `- Remove filler words (uh, um, basically, you know)\n` +
            `- Fix misheard homophones ONLY if clearly wrong (e.g., "plot code" → "Claude Code")\n` +
            `- Do NOT change words that are already correct — "sessions" stays "sessions", not "sections"\n` +
            `- Do NOT rephrase or summarize — keep the original phrasing\n` +
            `- Keep ALL specific details: app names, URLs, issue numbers, technical terms\n` +
            `Output ONLY the cleaned text, nothing else.\n\n` +
            `Original: ${cleanGoal}`,
          context: {
            system_override: 'You fix encoding errors and typos in task descriptions. Be conservative — do NOT change words that are already correct. Output ONLY the cleaned text.',
            max_tokens: 500,
          },
        }, { timeout: 15000 });
        const cleaned = (cleanupRes.data?.response_text || cleanupRes.data?.response || '').trim();
        if (cleaned && cleaned.length > 10) {
          this.logger.log(`Goal cleaned: "${cleanGoal.slice(0, 50)}" → "${cleaned.slice(0, 50)}"`);
          cleanGoal = cleaned;
        }
      } catch (err: any) {
        this.logger.debug(`Goal cleanup failed: ${err.message} — using original`);
      }
    }

    const sessionId = `cu-${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();
    const policy = { ...DEFAULT_POLICY, ...dto.policy };

    const session: ComputerUseSession & { visionGranted: boolean } = {
      session_id: sessionId,
      goal: cleanGoal,
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

    // Phase 7: Identity & ownership — scope session memory to project/user
    if (dto.project_id) {
      (session as any)._project_id = dto.project_id;
    }
    if (dto.user_id) {
      (session as any)._user_id = dto.user_id;
    }

    // ── Default browser app for native keyboard routing ───────────────────────
    //
    // Native keystroke actions (key_press hotkeys like cmd+a, the AppleScript
    // fallback path of `type`) use an `app:` parameter to target the correct
    // process. Without it, AppleScript sends keystrokes to whatever is
    // frontmost — which may not be the CU target window.
    //
    // If the caller supplied share_info/capture_target we can resolve the app
    // from those. But CU sessions created via API (without a screen share —
    // e.g., from backend tests, webhooks, or headless automation) have neither.
    // In that case, if Chrome Bridge is connected, default to Google Chrome:
    // the Chrome Bridge's presence is strong evidence that Chrome is the
    // intended working canvas for this session.
    //
    // We distinguish `_browser_app` from `_native_app_mode` intentionally:
    // `_native_app_mode` being set forces the AppleScript path in `type` (no
    // Chrome Bridge attempt). `_browser_app` is purely a keyboard-routing hint
    // used as the `app:` parameter — it leaves the Chrome-Bridge-first type
    // path intact.
    if (!dto.share_info && !dto.capture_target && !(session as any)._native_app_mode) {
      try {
        const health = await this.runtime.health();
        if (health && health.platform !== 'unknown') {
          (session as any)._browser_app = 'Google Chrome';
          this.logger.log(`Session ${sessionId}: no share/capture target provided; runtime healthy → defaulting _browser_app to "Google Chrome" for native keyboard routing`);
        }
      } catch {
        // dev-agent unreachable — skip default silently
      }
    }

    sessions.set(sessionId, session);
    this.persistSession(session);  // durable snapshot on creation

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
      if (session.status !== 'failed' && (session.status as string) !== 'cancelled') {
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

    // Begin execution — uses the approved plan as guidance, adapts on the fly
    this.executeAdaptiveLoop(id).catch((err) => {
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
    this.persistSession(session);

    // Phase 5: Handoff note — write a human-readable checkpoint so the user
    // (or a returning session) can understand the state without reading JSON.
    const currentStep = session.plan[session.current_step];
    const mem = new SessionMemory(id);
    const note = [
      `# Handoff — session paused at ${new Date().toISOString()}`,
      '',
      `**Goal:** ${session.goal}`,
      `**At step:** ${session.current_step + 1}/${session.plan.length}`,
      ...(currentStep ? [
        `**Current step:** ${currentStep.action} — ${currentStep.description || '(no description)'}`,
        ...(currentStep.target ? [`**Target:** ${currentStep.target}`] : []),
      ] : []),
      '',
      'The agent is paused. To resume: POST /sessions/' + id + '/resume',
      'To add context for the agent before resuming: POST /sessions/' + id + '/user-note with { "note": "your instruction" }',
    ].join('\n');
    mem.write('HANDOFF.md', note).catch(() => {});

    return { status: 'paused' };
  }

  /** Phase 5: User injects a note for the agent to read on next step. */
  @Post('sessions/:id/user-note')
  async addUserNote(@Param('id') id: string, @Body() body: { note: string }) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (!body.note?.trim()) throw new HttpException('Note required', HttpStatus.BAD_REQUEST);
    const mem = new SessionMemory(id);
    const entry = `- [${new Date().toISOString()}] ${body.note.trim()}\n`;
    await mem.write('USER_NOTES.md', entry, true);
    this.logger.log(`Session ${id}: user added note (${body.note.length} chars)`);
    return { ok: true };
  }

  @Post('sessions/:id/resume')
  async resumeSession(@Param('id') id: string) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (session.status !== 'paused' && session.status !== 'awaiting_click_assist' && session.status !== 'awaiting_credential') {
      throw new HttpException(`Cannot resume: status is "${session.status}"`, HttpStatus.CONFLICT);
    }
    // Learn from click-assist: capture what the user did so the agent
    // can replicate it next time without needing help.
    if (session.status === 'awaiting_click_assist') {
      const assistData = (session as any)._click_assist;
      const failedTarget = assistData?.target || '';

      // Take a screenshot AFTER user's manual action to see what changed
      try {
        const afterScreen = await this.getScreenImage(id);
        let pageText = '';
        try {
          const textRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'get_page_text',
          }, { timeout: 10000 });
          if (textRes.data?.success) pageText = (textRes.data.output as string).slice(0, 1000);
        } catch { /* ignore */ }

        // Ask the LLM to observe what the user did and extract a reusable rule
        const learnRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
          user_message:
            `The CU agent was trying to: "${failedTarget}" but couldn't find the element.\n` +
            `The user manually performed the action. After the user's action, the screen shows:\n` +
            `${pageText.slice(0, 800)}\n\n` +
            `What did the user likely do? Extract a reusable rule:\n` +
            `CONDITION: <when this situation occurs>\n` +
            `CONCLUSION: <what to do instead>\n\n` +
            `Reply with ONLY the CONDITION and CONCLUSION lines.`,
          context: {
            system_override: 'Observe what the user did during click-assist and extract a reusable IF/THEN rule. Reply ONLY with CONDITION: and CONCLUSION: lines.',
            max_tokens: 200,
            ...(afterScreen ? { screen_image: afterScreen } : {}),
          },
        }, { timeout: 15000 });

        const ruleText = (learnRes.data?.response_text || learnRes.data?.response || '').trim();
        const condMatch = ruleText.match(/CONDITION:\s*(.+)/i);
        const concMatch = ruleText.match(/CONCLUSION:\s*(.+)/i);

        if (condMatch && concMatch) {
          const rule = { condition: condMatch[1].trim(), conclusion: concMatch[1].trim() };
          this.logger.log(`Click-assist learning: ${rule.condition} → ${rule.conclusion}`);

          // Store as a memory rule via the memory service
          try {
            await axios.post(`${MEMORY_URL}/internal/memory/rules`, {
              condition: rule.condition,
              conclusion: rule.conclusion,
              source: 'click_assist_learning',
              goal_context: session.goal,
            }, { timeout: 5000 });
          } catch { /* best effort */ }

          // Also inject into the session's action history so the adaptive loop knows
          const currentStep = session.plan[session.current_step];
          if (currentStep) {
            currentStep.output = `User manually performed: "${failedTarget}". Learned: ${rule.conclusion}`;
          }
        }
      } catch (err: any) {
        this.logger.debug(`Click-assist learning failed: ${err.message}`);
      }

      (session as any)._click_assist = null;
    }
    session.status = 'executing';
    session.error = undefined;
    session.updated_at = new Date().toISOString();
    this.persistSession(session);
    this.executeAdaptiveLoop(id).catch(() => {});
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

  /**
   * Get click-assist data — annotated screenshot with numbered clickable elements.
   * Used by the mobile companion to render element picker when a click fails.
   */
  @Get('sessions/:id/click-assist')
  getClickAssist(@Param('id') id: string) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    const assist = (session as any)._click_assist;
    if (!assist) return { active: false };
    return {
      active: session.status === 'awaiting_click_assist',
      screenshot: assist.screenshot,
      elements: assist.elements,
      target: assist.target,
    };
  }

  /**
   * User selected a numbered element — click at that position and resume execution.
   */
  @Post('sessions/:id/click-assist')
  async submitClickAssist(@Param('id') id: string, @Body() body: { number: number }) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (session.status !== 'awaiting_click_assist') {
      throw new HttpException('Session is not awaiting click assist', HttpStatus.BAD_REQUEST);
    }
    const assist = (session as any)._click_assist;
    if (!assist?.elements?.length) {
      throw new HttpException('No click assist data', HttpStatus.BAD_REQUEST);
    }

    const selected = assist.elements.find((e: any) => e.number === body.number);
    if (!selected) {
      throw new HttpException(`Element #${body.number} not found`, HttpStatus.BAD_REQUEST);
    }

    this.logger.log(`Click assist: user selected #${body.number} "${selected.description}" at (${selected.x_ratio}, ${selected.y_ratio})`);

    // Convert ratios to native screen coordinates
    try {
      const screensRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
        tool: 'computer_action', action: 'list_screens',
      }, { timeout: 5000 });
      const screens = screensRes.data?.screens || [];
      const scr = screens[0] || { x: 0, y: 0, width: 1920, height: 1080 };
      const clickX = Math.round(scr.x + selected.x_ratio * scr.width);
      const clickY = Math.round(scr.y + selected.y_ratio * scr.height);

      await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
        tool: 'computer_action', action: 'click', x: clickX, y: clickY,
      }, { timeout: 10000 });

      this.logger.log(`Click assist: clicked at native (${clickX}, ${clickY})`);
    } catch (err: any) {
      this.logger.error(`Click assist click failed: ${err.message}`);
    }

    // Clear assist data and resume execution
    (session as any)._click_assist = null;
    session.status = 'executing';
    session.updated_at = new Date().toISOString();

    // Resume the adaptive loop
    this.executeAdaptiveLoop(id).catch(() => {});

    return { ok: true, clicked: selected };
  }

  /**
   * Follow up on a completed/failed session with user feedback.
   * Reopens the session, injects the feedback, and continues executing.
   * Also teaches the system from the feedback for future sessions.
   */
  @Post('sessions/:id/follow-up')
  async followUp(@Param('id') id: string, @Body() body: { message: string }) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    if (!body.message?.trim()) throw new HttpException('Feedback message required', HttpStatus.BAD_REQUEST);

    const feedback = body.message.trim();
    this.logger.log(`Follow-up on ${id}: "${feedback}"`);

    // 1. Teach from the feedback — store lesson for future sessions
    this.teachFromFeedback(session.goal, feedback, session.plan).catch(err => {
      this.logger.warn(`Teaching from feedback failed: ${err.message}`);
    });

    // 2. Reopen the session
    session.status = 'executing';
    session.error = undefined;
    session.updated_at = new Date().toISOString();

    // Inject feedback as high-priority context
    const queue: string[] = (session as any)._feedback_queue || [];
    queue.push(`USER CORRECTION: ${feedback}`);
    (session as any)._feedback_queue = queue;

    // Add a new step to continue from
    session.plan.push({
      index: session.plan.length,
      description: `Follow-up: ${feedback.slice(0, 60)}`,
      action: 'read_screen',
      target: '',
      status: 'pending',
    });

    // 3. Resume adaptive execution
    this.executeAdaptiveLoop(id).catch(() => {});

    return { status: 'executing', message: 'Session reopened with your feedback' };
  }

  /**
   * Extract a lesson from user feedback on a CU session and store it
   * via the teaching service for future reference.
   */
  private async teachFromFeedback(goal: string, feedback: string, plan: PlanStep[]): Promise<void> {
    const completedSteps = plan
      .filter(s => s.status === 'completed' || s.status === 'failed')
      .map(s => `${s.action}: ${s.description} → ${(s.output || '').slice(0, 100)}`)
      .join('\n');

    // Generate a condition/conclusion rule from the feedback
    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message:
          `A computer-use task was attempted but the user says it wasn't done correctly.\n\n` +
          `GOAL: ${goal}\n` +
          `USER FEEDBACK: ${feedback}\n` +
          `STEPS TAKEN:\n${completedSteps.slice(0, 1500)}\n\n` +
          `Extract a reusable rule in IF/THEN format:\n` +
          `Line 1: CONDITION: <when this situation occurs>\n` +
          `Line 2: CONCLUSION: <do this instead>\n\n` +
          `Examples:\n` +
          `CONDITION: closing a Facebook page called Kive\n` +
          `CONCLUSION: navigate directly to facebook.com/kiveteam instead of searching, then use Meta Business Suite settings\n\n` +
          `CONDITION: clicking Settings on a Facebook page\n` +
          `CONCLUSION: the sidebar Settings link goes to account settings, not page settings. Use business.facebook.com/latest/settings instead\n\n` +
          `Reply with ONLY the CONDITION and CONCLUSION lines.`,
        context: { system_override: 'Extract an IF/THEN rule. Reply with ONLY CONDITION: and CONCLUSION: lines.', max_tokens: 150 },
      }, { timeout: 15000 });

      const text = (res.data?.response_text || res.data?.response || '').trim();
      const condMatch = text.match(/CONDITION:\s*(.+)/i);
      const concMatch = text.match(/CONCLUSION:\s*(.+)/i);

      if (condMatch && concMatch) {
        const condition = condMatch[1].trim();
        const conclusion = concMatch[1].trim();
        this.logger.log(`CU rule learned: "${condition}" → "${conclusion}"`);

        // Store in Neo4j via memory service
        await this.storeMemoryRule(condition, conclusion, 0.85);
      } else {
        // Fallback: store the raw text as a rule
        const lesson = text.slice(0, 200);
        if (lesson.length > 10) {
          await this.storeMemoryRule(`computer-use task: ${goal.slice(0, 80)}`, lesson, 0.7);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to extract lesson: ${err.message}`);
    }
  }

  @Delete('sessions/:id')
  async cancelSession(@Param('id') id: string) {
    const session = sessions.get(id);
    if (!session) throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    session.status = 'cancelled';
    session.visionGranted = false; // revoke vision on cancel
    session.updated_at = new Date().toISOString();
    this.persistSession(session);
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
  /**
   * Research the goal via web search before planning.
   * Returns formatted guide text to inject into the plan prompt.
   */
  /**
   * Query Neo4j memory for CU-relevant rules and lessons learned from past sessions.
   */
  private async queryMemoryForCU(goal: string): Promise<string> {
    try {
      // Extract keywords from the goal for rule matching
      const keywords = goal.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 8)
        .join(',');

      const res = await axios.get(`${MEMORY_URL}/internal/memory/rules`, {
        params: { keywords },
        timeout: 5000,
      });

      const rules = res.data?.rules || [];
      if (rules.length === 0) return '';

      const formatted = rules
        .slice(0, 10)
        .map((r: { condition: string; conclusion: string; confidence: number }, i: number) =>
          `${i + 1}. IF ${r.condition} THEN ${r.conclusion} (confidence: ${r.confidence})`)
        .join('\n');

      this.logger.log(`CU memory: found ${rules.length} relevant rules for "${goal.slice(0, 50)}"`);
      return `KNOWLEDGE FROM PREVIOUS SESSIONS (follow these rules):\n${formatted}\n`;
    } catch (err: any) {
      this.logger.debug(`CU memory query failed: ${err.message}`);
      return '';
    }
  }

  /**
   * Store a CU lesson as a rule in Neo4j memory for future sessions.
   */
  private async storeMemoryRule(condition: string, conclusion: string, confidence: number = 0.8): Promise<void> {
    try {
      await axios.post(`${MEMORY_URL}/internal/memory/teach`, {
        condition,
        conclusion,
        confidence,
        source: 'computer-use',
      }, { timeout: 10000 });
      this.logger.log(`CU rule stored: "${condition}" → "${conclusion}"`);
    } catch (err: any) {
      this.logger.debug(`CU rule store failed: ${err.message}`);
    }
  }

  /**
   * Learn from a completed CU session — extract reusable rules and store in Neo4j.
   * Called after every successful session so future sessions benefit.
   */
  private async learnFromSession(session: ComputerUseSession & { visionGranted: boolean }): Promise<void> {
    const completedSteps = session.plan
      .filter(s => s.status === 'completed')
      .map(s => `${s.action}: ${s.description}`)
      .join(' → ');

    if (completedSteps.length < 20) return; // Too short to learn from

    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message:
          `A computer-use task was completed successfully.\n\n` +
          `GOAL: ${session.goal}\n` +
          `STEPS THAT WORKED: ${completedSteps.slice(0, 1000)}\n\n` +
          `Extract the KEY INSIGHT about HOW this was accomplished, as an IF/THEN rule:\n` +
          `CONDITION: <when user wants to do this type of task>\n` +
          `CONCLUSION: <the efficient approach that worked>\n\n` +
          `Focus on URLs, navigation paths, or UI elements that were important.\n` +
          `Reply with ONLY CONDITION: and CONCLUSION: lines.`,
        context: { system_override: 'Extract a reusable rule. CONDITION: and CONCLUSION: only.', max_tokens: 150 },
      }, { timeout: 15000 });

      const text = (res.data?.response_text || res.data?.response || '').trim();
      const condMatch = text.match(/CONDITION:\s*(.+)/i);
      const concMatch = text.match(/CONCLUSION:\s*(.+)/i);

      if (condMatch && concMatch) {
        await this.storeMemoryRule(condMatch[1].trim(), concMatch[1].trim(), 0.9);
      }
    } catch (err: any) {
      this.logger.debug(`learnFromSession failed: ${err.message}`);
    }
  }

  // ── CU Learning Memory integration ──────────────────────────────────────

  /**
   * Query for a learned skill that matches the goal.
   * Returns stored steps if a high-confidence skill exists.
   */
  private async querySkillForCU(goal: string): Promise<{ found: boolean; steps?: string[]; skillId?: string }> {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/cu/skill/find`, {
        params: { intent: goal, min_success_rate: 0.75 },
        timeout: 5000,
      });
      if (res.data?.found && res.data.skill?.steps?.length >= 2) {
        this.logger.log(`CU skill found: "${res.data.skill.name?.slice(0, 50)}" (${res.data.skill.steps.length} steps, rate=${res.data.skill.success_rate})`);
        return {
          found: true,
          steps: res.data.skill.steps,
          skillId: res.data.skill.id,
        };
      }
    } catch (err: any) {
      this.logger.debug(`querySkillForCU failed: ${err.message}`);
    }
    return { found: false };
  }

  /** Fire-and-forget: save a CU action execution to memory. */
  private async saveActionToMemory(
    action: string, target: string, success: boolean,
    context: string, uiElementId?: string, skillId?: string,
  ): Promise<string | null> {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/cu/action`, {
        type: action,
        target: target.slice(0, 200),
        success,
        ui_element_id: uiElementId || null,
        skill_id: skillId || null,
      }, { timeout: 5000 });
      return res.data?.action_id || null;
    } catch { return null; }
  }

  /** Fire-and-forget: save a UI element to memory. */
  private async saveUIElementToMemory(
    text: string, type: string, xRatio: number, yRatio: number, context: string,
  ): Promise<string | null> {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/cu/ui-element`, {
        text: text.slice(0, 100), type, x_ratio: xRatio, y_ratio: yRatio,
        context: context.slice(0, 100),
      }, { timeout: 5000 });
      return res.data?.element_id || null;
    } catch { return null; }
  }

  /** Create a reusable skill from a completed CU session. */
  private async createSkillFromSession(
    session: ComputerUseSession & { visionGranted: boolean },
  ): Promise<void> {
    const completedSteps = session.plan
      .filter(s => s.status === 'completed')
      .map(s => `${s.action}: ${s.description}`);

    if (completedSteps.length < 2) return;

    // Don't store skills from sessions that had failures or used unknown actions
    const validActions = new Set([
      'navigate', 'click', 'scroll', 'type', 'key_press', 'open_app',
      'read_screen', 'read_page', 'click_screen', 'wait', 'hotkey',
      'execute_plan', 'done', 'skip', 'switch_tab',
    ]);
    const hasUnknownActions = session.plan.some(s =>
      s.output?.includes('Unknown action') || !validActions.has(s.action || ''),
    );
    const hasTooManyFailures = session.plan.filter(s => s.status === 'failed').length >= 2;
    const hasReadScreenSpam = session.plan.filter(s =>
      s.action === 'read_screen' && s.description?.includes('Checking if goal'),
    ).length > 5;

    if (hasUnknownActions || hasTooManyFailures || hasReadScreenSpam) {
      this.logger.log(`Skipping skill creation — session had quality issues (unknown=${hasUnknownActions}, failures=${hasTooManyFailures}, spam=${hasReadScreenSpam})`);
      return;
    }

    try {
      await axios.post(`${MEMORY_URL}/internal/memory/cu/skill`, {
        name: session.goal.slice(0, 100),
        intent: session.goal,
        steps: completedSteps.slice(0, 20),
        ui_element_ids: ((session as any)._ui_element_ids || []).slice(0, 30),
      }, { timeout: 10000 });
      this.logger.log(`Skill created from session: "${session.goal.slice(0, 60)}"`);
    } catch (err: any) {
      this.logger.debug(`createSkillFromSession failed: ${err.message}`);
    }
  }

  // ── Click Assist: numbered element tagging on failed clicks ─────────────

  /**
   * When a click fails, take a screenshot, send to vision LLM to identify
   * clickable elements with numbered tags, then pause the session for user input.
   */
  private async requestUserClickAssist(
    sessionId: string,
    screenshot: string,
    failedTarget: string,
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message:
          `I tried to click "${failedTarget}" but it failed. Look at this screenshot and identify all clickable elements.\n\n` +
          `For each clickable element (buttons, links, tabs, menu items, input fields, icons), provide:\n` +
          `- number (1-15)\n` +
          `- description (what it is)\n` +
          `- x_ratio (horizontal position as 0.0-1.0 from left edge)\n` +
          `- y_ratio (vertical position as 0.0-1.0 from top edge)\n\n` +
          `Reply with ONLY a JSON array, no other text:\n` +
          `[{"number":1,"description":"...","x_ratio":0.5,"y_ratio":0.3}, ...]`,
        context: {
          system_override:
            'You analyze screenshots and identify clickable UI elements. ' +
            'Output ONLY a valid JSON array. No markdown, no explanation. ' +
            'Include buttons, links, tabs, menu items, icons, and input fields. ' +
            'Coordinates are ratios (0.0 = left/top edge, 1.0 = right/bottom edge).',
          max_tokens: 1000,
          screen_image: screenshot,
        },
      }, { timeout: 30000 });

      const text = (res.data?.response_text || res.data?.response || '').trim();

      // Parse JSON array from response (may be wrapped in ```json blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      let elements: any[] = [];
      if (jsonMatch) {
        try {
          elements = JSON.parse(jsonMatch[0]);
        } catch { /* parsing failed */ }
      }

      if (elements.length === 0) {
        this.logger.warn(`Click assist: vision LLM returned no elements for "${failedTarget}"`);
        return; // Don't pause — let the agent continue trying
      }

      // Store assist data on session and pause for user input
      (session as any)._click_assist = {
        screenshot,
        elements,
        target: failedTarget,
        timestamp: new Date().toISOString(),
      };
      session.status = 'awaiting_click_assist';
      session.error = `Click failed for "${failedTarget}" — click it manually, then press Resume`;
      session.updated_at = new Date().toISOString();

      this.logger.log(`Click assist: ${elements.length} elements identified for "${failedTarget}" — waiting for user`);
    } catch (err: any) {
      this.logger.debug(`Click assist failed: ${err.message}`);
    }
  }

  // ── End CU Learning Memory ─────────────────────────────────────────────

  private async researchGoal(goal: string): Promise<string> {
    try {
      // Generate a search query focused on the ACTION the user wants to perform
      const queryRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message:
          `Generate a web search query to find step-by-step instructions for this task:\n` +
          `"${goal}"\n\n` +
          `Reply with ONLY the search query (one line, no quotes).\n` +
          `IMPORTANT: Focus on the PRIMARY ACTION (delete, close, deactivate, create, change, etc.) not on secondary details.\n` +
          `Always include the current year (2026) and "step by step" for better results.\n` +
          `Examples:\n` +
          `- "close my Facebook page Kive" → "how to delete deactivate Facebook page step by step 2026"\n` +
          `- "list all my github repos" → "how to view all repositories on GitHub 2026"\n` +
          `- "change my Twitter display name" → "how to change display name on Twitter X step by step 2026"`,
        context: { system_override: 'Generate a web search query focused on the primary ACTION. Reply with ONLY the query.', max_tokens: 60 },
      }, { timeout: 15000 });
      const searchQuery = (queryRes.data?.response_text || queryRes.data?.response || '').trim();
      if (!searchQuery) return '';

      this.logger.log(`CU research: searching for "${searchQuery}"`);

      // Web search via tool-executor
      const searchRes = await axios.post(`${TOOL_EXECUTOR_URL}/internal/tool/execute`, {
        tool: 'web_search',
        command: searchQuery,
      }, { timeout: 15000 });

      if (!searchRes.data?.success) return '';

      // Tool-executor returns results array + formatted output
      const results = searchRes.data?.results || [];
      if (results.length > 0) {
        const guide = results
          .map((r: { title: string; snippet: string; url: string }, i: number) =>
            `${i + 1}. ${r.title}\n   ${r.snippet}\n   Source: ${r.url}`)
          .join('\n');
        this.logger.log(`CU research: found ${results.length} results for "${searchQuery}"`);

        // Fetch detailed content from the most relevant result (official help pages first)
        let detailedGuide = '';
        const officialUrl = results.find((r: { url: string }) =>
          /facebook\.com\/help|meta\.com|support\.|help\.|wikihow|localiq/i.test(r.url))?.url
          || results[0]?.url;

        if (officialUrl) {
          try {
            const browseRes = await axios.post(`${TOOL_EXECUTOR_URL}/internal/tool/execute`, {
              tool: 'browse_url',
              url: officialUrl,
            }, { timeout: 20000 });
            if (browseRes.data?.success && browseRes.data.output) {
              detailedGuide = `\nDETAILED GUIDE (from ${officialUrl}):\n${(browseRes.data.output as string).slice(0, 3000)}\n`;
              this.logger.log(`CU research: fetched ${detailedGuide.length} chars from ${officialUrl}`);
            }
          } catch { /* browsing failed — use snippets only */ }
        }

        return `WEB RESEARCH (how to achieve this goal):\n${guide}\n${detailedGuide}`;
      }

      // Fallback: use the formatted output string
      const output = searchRes.data?.output || '';
      if (output && output !== 'No results found') {
        this.logger.log(`CU research: got formatted results for "${searchQuery}"`);
        return `WEB RESEARCH (how to achieve this goal):\n${output}\n`;
      }
      return '';
    } catch (err: any) {
      this.logger.warn(`CU research failed: ${err.message} — planning without research`);
      return '';
    }
  }

  private async draftPlan(
    sessionId: string,
    goal: string,
    policy: typeof DEFAULT_POLICY,
    screenImage?: string,
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    // ── Skill-first: check if a learned skill can provide the plan ──
    // Skill reuse temporarily disabled — matching is too loose and reuses
    // plans from unrelated goals. TODO: improve skill matching precision.
    const skill = await this.querySkillForCU(goal);
    const useSkill = false; // DISABLED: skill matching reuses wrong plans
    if (useSkill && skill.found && skill.steps && skill.steps.length >= 2) {
      this.logger.log(`Using learned skill (${skill.steps.length} steps) for "${goal.slice(0, 50)}"`);
      (session as any)._active_skill_id = skill.skillId;
      // Extract the question/query from the goal for the type step
      // e.g., "Open ChatGPT and ask it: Would it be feasible..." → "Would it be feasible..."
      const goalQuestion = (() => {
        // Try common patterns: "ask it: ...", "ask: ...", "ask it ..."
        const askMatch = goal.match(/ask\s+(?:it\s*)?[:\-]?\s*(.+)/i);
        if (askMatch) return askMatch[1].trim();
        // Fallback: use the goal as-is
        return goal;
      })();

      session.plan = skill.steps.map((s, i) => {
        const colonIdx = s.indexOf(': ');
        const action = colonIdx > 0 ? s.slice(0, colonIdx).trim() : 'read_screen';
        const description = colonIdx > 0 ? s.slice(colonIdx + 2).trim() : s;

        // Set target based on action type
        let target = '';
        if (action === 'type') {
          target = goalQuestion; // The actual question to type
        } else if (action === 'open_app') {
          // Extract app name from description or goal
          const appMatch = goal.match(/open\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+(?:desktop\s+)?app/i);
          target = appMatch ? appMatch[1] : description;
        } else if (action === 'key_press') {
          // Extract key from description (e.g., "Create new chat with Cmd+N" → "command+n")
          const cmdN = description.match(/cmd\+n|command\+n/i);
          const enter = description.match(/enter|return|send/i);
          if (cmdN) target = 'command+n';
          else if (enter) target = 'enter';
          else target = description;
        }

        return {
          index: i,
          description,
          action,
          target,
          status: 'pending' as const,
        };
      });
      if ((session.status as string) === 'cancelled') return;
      session.status = 'awaiting_approval';
      session.updated_at = new Date().toISOString();
      return; // Skill provides the plan — skip LLM planning
    }

    // ── No skill found — fall through to existing logic engine + LLM planning ──

    const hasScreen = !!screenImage;
    const shareCtx = this.getShareContext(sessionId);

    // ── Query Neo4j memory for past CU knowledge (IF/THEN rules — logic engine) ──
    const memoryCtx = await this.queryMemoryForCU(goal);

    // ── Pre-plan research: search the web for how to accomplish the goal ──
    const researchContext = await this.researchGoal(goal);
    if (researchContext) {
      (session as any)._research = researchContext;
    }

    const lessonsCtx = memoryCtx; // Neo4j rules replace in-memory lessons

    // ── CU skill registry (DB-backed): prepend strong priors for known apps/flows ──
    const [skillPlanGuidance, matchedSkills] = await Promise.all([
      planGuidanceFor(goal),
      matchSkills(goal),
    ]);
    if (matchedSkills.length > 0) {
      this.logger.log(`Plan: matched ${matchedSkills.length} CU skill(s): ${matchedSkills.map(s => s.id).join(', ')}`);
      (session as any)._matched_skills = matchedSkills.map(s => s.id);
    }

    const systemPrompt =
      `You are a computer-use planner. You create SHORT, efficient step-by-step plans to control a real computer.\n\n` +
      skillPlanGuidance +
      lessonsCtx +
      (researchContext ? `${researchContext}\nUse the research above to inform your plan. Follow the documented steps from trusted sources rather than guessing.\n\n` : '') +
      `SHARED SCREEN CONTEXT:\n${shareCtx}\n\n` +
      `${hasScreen ? 'A screenshot of the current screen is attached. ANALYZE IT FIRST before planning:\n' +
        '1. What application/browser is currently open?\n' +
        '2. Is the user ALREADY logged in? (Look for profile avatars, usernames, dashboard elements)\n' +
        '3. What page/URL is currently visible?\n' +
        '4. What is the current state? (e.g., already on GitHub homepage, already on repos page)\n' +
        'YOUR PLAN MUST START FROM THE CURRENT STATE. Do NOT include steps for things already done.\n\n' :
        'No screenshot available. Start with a "read_screen" step to observe the screen.\n\n'}` +
      `OUTPUT FORMAT: One step per line using this format (NO JSON, NO markdown):\n` +
      `STEP: <action> | <target> | <description>\n` +
      `Only click_scoped takes a FOURTH field (the anchor):\n` +
      `STEP: click_scoped | <target aria-label> | <description> | <anchor text>\n\n` +
      `ACTIONS:\n` +
      `BROWSER (for ANY web page — these use the Chrome extension and are fast + reliable):\n` +
      `- navigate | <full URL> | description — opens a URL in the browser\n` +
      `- click | <button text, link text, menu item, placeholder text> | description — clicks a DOM element by text match via Chrome extension. ALWAYS use this for web pages.\n` +
      `- click_scoped | <TARGET aria-label> | description | <ANCHOR text>\n` +
      `    The FIELDS are: position 2 = TARGET (the control's aria-label), position 4 = ANCHOR (the container-identifying text prefix). Do NOT swap them.\n` +
      `    Use INSTEAD of click when the page has many sibling elements sharing the same aria-label. The ANCHOR is a unique substring (30-60 chars) that identifies the container whose control you want; we walk UP from the anchor text, then DOWN inside that container for the TARGET.\n` +
      `    TARGET = the button label you would have passed to a plain "click" (e.g. "Actions for this post", "Edit post", "Save", "Lưu").\n` +
      `    ANCHOR = the first 30-60 chars of the target container's unique body text (e.g. the goal's quoted post prefix).\n` +
      `    EXAMPLE (Facebook edit — three-dot menu):\n` +
      `      STEP: click_scoped | Actions for this post | Open the target post's three-dot menu | Hôm nay mình vừa khám phá một cách làm việc với AI\n` +
      `      (TARGET="Actions for this post" is the 2nd field, ANCHOR="Hôm nay..." is the 4th.)\n` +
      `    EXAMPLE (same skill — Edit option in that menu):\n` +
      `      STEP: click_scoped | Edit post | Click the Edit option | Hôm nay mình vừa khám phá một cách làm việc với AI\n` +
      `- type | <text to type> | description — types text into the focused field\n` +
      `- scroll | up/down | description — scrolls the page\n` +
      `- read_screen | | description — captures screenshot AND extracts all visible text\n` +
      `- key_press | <key or combo e.g. enter, ${hostModifier()}+l> | description\n` +
      `NATIVE DESKTOP (ONLY for non-browser apps like Finder, Notes, Terminal):\n` +
      `- open_app | <app name> | description — focus/launch a native macOS app\n` +
      `- click_screen | <element description> | description — find and click using vision (ONLY for native apps, NOT for websites)\n` +
      `- wait | <seconds> | description — waits (only if page needs time to load)\n\n` +
      `IMPORTANT:\n` +
      `- PREFER native desktop apps over browser. If ChatGPT/Claude/Slack/Discord/etc. has a desktop app, use open_app — do NOT navigate to the website.\n` +
      `- Only use navigate/browser when there is NO native app for the service.\n` +
      `- BROWSER-ONLY (use navigate, NOT open_app): Facebook, GitHub, Twitter/X, LinkedIn, Reddit, Google, Amazon, YouTube, any website\n` +
      `- NATIVE APP (use open_app): ChatGPT, Claude, Slack, Discord, Finder, Notes, Terminal, Mail, Messages\n` +
      `- "Claude Code" = try open_app Claude first (desktop app). Only if no desktop app found, fall back to Terminal + 'claude' command.\n` +
      `- For native apps: open_app → read_screen → click_screen\n\n` +
      `EFFICIENCY RULES (these are critical):\n` +
      `1. Generate 3-6 steps. Fewer is better. Every step costs time.\n` +
      `2. NEVER use "screenshot" as a standalone step — "read_screen" already captures the screen AND extracts text. Use read_screen instead.\n` +
      `3. NEVER put "wait" after "navigate" — the navigate action already waits for page load.\n` +
      `4. NEVER put "screenshot" before "read_screen" — read_screen already takes a screenshot.\n` +
      `5. ALWAYS use "navigate" with a direct URL — NEVER use "click" to navigate between pages.\n` +
      `   navigate is 10x faster and more reliable than clicking links.\n` +
      `   Examples: "check issues" → navigate https://github.com/theaiinc/oasis-cognition/issues\n` +
      `            "issue 17" → navigate https://github.com/theaiinc/oasis-cognition/issues/17\n` +
      `            "facebook profile" → navigate https://www.facebook.com/USERNAME\n` +
      `   If you can construct the URL, ALWAYS use navigate. NEVER click links to navigate.\n` +
      `6. For GitHub: ALWAYS construct direct URLs:\n` +
      `   - Issues: /issues  - Specific issue: /issues/17  - PRs: /pulls  - Code: /tree/main/path\n` +
      `   NEVER click "Issues" tab or any GitHub nav link — navigate to the URL directly.\n` +
      `7. BEFORE typing text, ALWAYS click the input field first with click_screen. Text input requires focus.\n` +
      `   Example: To type in ChatGPT → click_screen "Message ChatGPT input" THEN type "your query"\n` +
      `   Example: To type in a search bar → click_screen "Search" THEN type "search term"\n` +
      `7. One "read_screen" is enough per page — do NOT repeat read_screen unless you scrolled.\n` +
      `8. SCROLL UP FIRST when looking for elements (nav bars, inputs, post buttons are usually above). Only scroll DOWN if up finds nothing.\n` +
      `9. Plans execute LINEARLY — NO conditional logic.\n\n` +
      `OTHER RULES:\n` +
      `- NEVER include login/signup/authentication steps. Assume the user is already logged in.\n` +
      `- NEVER use placeholders like USERNAME or USER in URLs.\n` +
      `  When you need an unknown value, use this discovery pattern:\n` +
      `  STEP: read_screen | | Read screen to discover username\n` +
      `  STEP: navigate | https://github.com/__DISCOVERED_USERNAME__?tab=repositories | Go to repos page\n` +
      `  The execution engine replaces __DISCOVERED_*__ tokens with values from read_screen.\n` +
      `- End with "read_screen" to capture the final result.\n` +
      `- NEVER interact with localhost:3000 (Oasis UI).\n` +
      `- If the goal mentions a page name or identifier, construct the URL directly (e.g., facebook.com/PAGENAME, github.com/USER).\n` +
      `- For page management (settings, delete, etc.): navigate to the page first, then look for Settings in the sidebar.\n` +
      `  If page settings don't work via click, try business.facebook.com/latest/settings/ for Facebook.\n` +
      `- POSTING ON SOCIAL MEDIA: use research results (from web search) to determine the exact steps.\n` +
      `  ALWAYS include a final read_screen step to verify the post was actually published.\n\n` +
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
        if ((session.status as string) === 'cancelled') return;
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
        anchor: (s as any).anchor,
        status: 'pending' as const,
      }));

      if ((session.status as string) === 'cancelled') return;
      session.status = 'awaiting_approval';
      session.updated_at = new Date().toISOString();
      this.logger.log(`Plan ready for ${sessionId}: ${session.plan.length} steps`);
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data).slice(0, 500)
        : err.message || 'Unknown error';
      this.logger.error(`Plan generation error for ${sessionId}: ${detail}`);
      if ((session.status as string) !== 'cancelled') {
        session.status = 'failed';
        session.error = `Plan generation failed: ${detail}`;
        session.updated_at = new Date().toISOString();
      }
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

      // Get page text for richer context (Chrome Bridge or OCR)
      let pageTextCtx = '';
      try {
        const ptRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
          tool: 'computer_action',
          action: 'get_page_text',
          text: (session as any)?._current_tab_hint || '',
        }, { timeout: 8000 });
        if (ptRes.data?.success && ptRes.data.output) {
          pageTextCtx = `\nCURRENT PAGE CONTENT:\n${(ptRes.data.output as string).slice(0, 3000)}\n`;
        }
      } catch { /* ignore — screenshot alone is enough */ }

      const skillReactHint = await reactGuidanceFor(goal);

      const userMessage =
        `OVERALL GOAL: ${goal}\n` +
        `CURRENT STEP (${step.index + 1}/${session.plan.length}): ${step.description}\n` +
        `STEP ACTION: ${step.action}${step.target ? ` → ${step.target}` : ''}\n` +
        `${skillReactHint}` +
        `${previousOutputs ? `\nINFO FROM PREVIOUS STEPS:\n${previousOutputs}\n` : ''}` +
        `${discoveryCtx}${feedbackContext}` +
        `SHARED SCREEN: ${shareCtx}\n` +
        `${pageTextCtx}` +
        `${historyBlock}${deadEndWarning}\n` +
        `The primary action "${step.action}" has ALREADY been executed. Screenshot of current screen is attached.\n` +
        `${verifyHint}\n`;

      // Two-stage verification:
      // 1. VL model DESCRIBES the screenshot (no reasoning)
      // 2. Text model (DeepSeek) DECIDES based on description + context
      let screenDescription = pageTextCtx || '';
      if (screen) {
        try {
          const descRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
            user_message: `Describe this screenshot. List all visible UI elements, text, buttons, dialogs, notifications, and the current state of the page. Be thorough and factual — no reasoning or recommendations.`,
            context: {
              system_override: 'You are a screenshot describer. Output ONLY a factual description of what is visible. Do NOT reason about actions, do NOT make recommendations. Just describe what you see.',
              max_tokens: 600,
              screen_image: screen,
            },
          }, { timeout: LLM_TIMEOUT_MS });
          const desc = (descRes.data?.response_text || descRes.data?.response || '').trim();
          if (desc) {
            screenDescription = `\nSCREEN DESCRIPTION (from vision model):\n${desc}\n`;
          }
        } catch { /* vision failed — use page text only */ }
      }

      // Replace screenshot context with text description for the reasoning model
      const verifyMessage = userMessage.replace(pageTextCtx, screenDescription);
      const cuTextModel = process.env.OASIS_TOOL_PLAN_LLM_MODEL || 'deepseek-v3.2';
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message: verifyMessage,
        context: {
          system_override: ComputerUseController.CU_AGENT_SYSTEM,
          max_tokens: 1024,
          model_override: cuTextModel,
          // No screen_image — reasoning model gets text description instead
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

  // ════════════════════════════════════════════════════════════════════════
  // PLAN-GUIDED ADAPTIVE LOOP
  //
  // Walks through the approved plan step by step. Before executing each
  // step, reads the page and asks the LLM whether the planned action
  // still makes sense. If yes, execute it. If no, the LLM can adapt:
  // modify the action, skip the step, or insert extra steps.
  //
  // This combines the reliability of a pre-approved plan with the
  // flexibility of real-time adaptation.
  // ════════════════════════════════════════════════════════════════════════

  private static readonly REACT_SYSTEM = `\
You are a SMART computer-use agent controlling a real macOS desktop. You can control BOTH the web browser AND native desktop apps.

OUTPUT (one field per line):
THOUGHT: <describe what you SEE on screen + what you need to do next> (1-2 sentences max, NO claims of success — just observations)
ACTION: <action>
TARGET: <value>

BROWSER ACTIONS (use these for ANY web page in Chrome):
- execute_plan — run the planned step as-is
- click | TARGET = text of the element to click (button label, link text, menu item, input placeholder). This uses the Chrome extension to find and click DOM elements — it is FAST and RELIABLE. ALWAYS prefer this over click_screen for websites.
- click_scoped | TARGET = aria-label or text of the control to click; additionally requires ANCHOR on the line below ACTION (not TARGET) containing a unique container-identifying substring (e.g. a post's first 30-60 chars). Use this INSTEAD OF click when the page has many sibling elements with the SAME label (every post on a Facebook profile has its own "Actions for this post" menu — plain click hits the FIRST one, click_scoped hits the one that belongs to the anchor's container). Emit as:
    ACTION: click_scoped
    ANCHOR: <unique text prefix identifying the correct container, e.g. the goal's quoted post-prefix>
    TARGET: <aria-label of the control inside that container>
- navigate | TARGET = full URL (opens in browser)
- type | TARGET = text to type into focused field
- scroll | TARGET = up or down
- read_screen — capture and read current screen content

NATIVE DESKTOP ACTIONS (use ONLY for non-browser apps like Finder, Notes, Terminal):
- open_app | TARGET = app name (e.g., "Claude", "Finder", "Terminal", "Notes", "Slack")
- key_press | TARGET = keyboard shortcut (e.g., "enter", "command+c", "command+tab", "escape")
- click_screen | TARGET = description of what to click (ONLY for native desktop apps, NOT for websites)

MEMORY ACTIONS (use to preserve information across steps — no context loss):
- scratch_write | TARGET = <full content to save as your working draft> — saves to SCRATCH.md (overwrites). Use this to persist drafts, summaries, or notes that you'll need in a later step. Example: after reading a long summary, write it here so it survives.
- scratch_append | TARGET = <content to append> — appends a new paragraph to SCRATCH.md.
- fact | TARGET = <single factual observation> — appends to MEMORY.md as a durable bullet point fact (URLs visited, usernames discovered, decisions made).

CONTROL ACTIONS:
- skip | TARGET = reason
- done | TARGET = evidence-based summary
- failed | TARGET = reason

CRITICAL RULES:
1. FOR WEBSITES: ALWAYS use "click" (Chrome extension DOM click) — NEVER use "click_screen" for web pages. "click" finds elements by text via the DOM and is 10x more reliable than screenshot-based clicking. "click_screen" is ONLY for native macOS apps.
2. PREFER NATIVE APPS over browser. If an app exists as a desktop application (ChatGPT, Claude, Slack, Discord, etc.), use open_app — do NOT open Chrome.
   - "open ChatGPT" → open_app ChatGPT (NOT navigate to chatgpt.com)
   - "message on Slack" → open_app Slack (NOT navigate to slack.com)
   - "check email" → open_app Mail (NOT navigate to gmail.com)
   - Only use navigate/browser when there is NO native app (e.g., Facebook, GitHub, custom websites)
2. DETECT the task context:
   - Native app tasks: open_app → read_screen → click_screen
   - Browser-only tasks: navigate → click → scroll
3. NAVIGATE DIRECTLY when you know the URL — ALWAYS prefer navigate over click for websites.
   - GitHub: construct URLs directly (e.g., /issues, /issues/17, /pulls). NEVER click "Issues" link — navigate to the URL.
   - Facebook: navigate to facebook.com, facebook.com/profile. NEVER click sidebar links.
   - Any website: if you can construct the URL, navigate — it's 10x faster and more reliable than clicking.
4. If a click TIMES OUT or has NO EFFECT, NEVER repeat the same click. Use navigate with a direct URL instead.
5. "done" requires REAL EVIDENCE from the screen showing the action was completed (e.g., "Post published", confirmation toast, the content visible). Simply navigating to a page is NOT done.
6. key_press works in the currently focused app.
7. After open_app, the screen shows OCR text from the native app — use click_screen to interact.
8. SCROLL PREFERENCE: When looking for an element, scroll UP first (nav bars, inputs, buttons are usually above). Only scroll DOWN if scrolling up finds nothing. Never scroll more than 3 times in the same direction without taking an action.
9. switch_tab: only try ONCE. If the tab doesn't exist, immediately use navigate instead. NEVER retry switch_tab. If you already tried switch_tab and it shows the same page, STOP switching and execute your planned action instead.
10. NEVER do consecutive passive actions (switch_tab, read_screen, scroll, navigate to the same URL) without a REAL action (click, type) in between.
11. TRUST THE PLAN: if the planned step is "click" on a specific element and you can see that element in the page text, EXECUTE THE CLICK. Do NOT switch tabs or navigate elsewhere — just click it.

READ THE SCREEN FIRST — always analyze what the UI is showing you:
- BEFORE attempting your planned action, look at the screenshot for ANY banners, prompts, dialogs, or calls-to-action that the page is showing.
- If the page says "Switch to X", "Log in as", "Verify your identity", "Accept cookies", or any other prompt, you MUST handle that FIRST before proceeding with your planned action.
- Click the prompted button (Switch Now, Accept, Continue, Dismiss, etc.) as an adapted action, then retry your planned action on the next step.
- Common examples: "Switch into [Page] to start managing it" → click "Switch Now". Cookie consent → click "Accept". Login wall → use credentials or report failed.
- If you see a banner or notification that blocks your target action, ALWAYS address the blocker first.
- After completing an action (Post, Submit, Save), read_screen to VERIFY the result before claiming done.
- If you truly don't know how to proceed, use "failed" with a description of what you're stuck on. Do NOT loop.`;

  private async executeAdaptiveLoop(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;

    const guard = validateSessionForExecution(session);
    if (!guard.allowed) {
      session.status = 'failed';
      session.error = guard.reason;
      session.updated_at = new Date().toISOString();
      return;
    }

    let researchCtx = (session as any)._research || '';
    // Query Neo4j for relevant CU rules
    const lessonsCtx = await this.queryMemoryForCU(session.goal);
    const MAX_EXTRA_STEPS = 8; // max adaptive steps beyond the original plan
    let consecutiveReadScreens = 0; // track read_screen spam
    const actionHistory: string[] = [];
    let prevPageText = '';
    let extraStepsUsed = 0;
    let consecutiveGoalRejections = 0;

    // Start user interference detection
    await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/cu-interference/start`, {
      session_id: sessionId,
    }, { timeout: 5000 }).catch(() => {});

    // Launch the always-on-top overlay window via dev-agent
    try {
      await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/cu-overlay/launch`, {
        session_id: sessionId,
        gateway_port: '8000',
      }, { timeout: 5000 });
      this.logger.log(`CU overlay launched for session ${sessionId}`);
    } catch { /* overlay not available — not critical */ }

    // Walk through each planned step
    const loopStartedAt = Date.now();
    while (session.current_step < session.plan.length && session.status === 'executing') {
      const step = session.plan[session.current_step];

      // Phase 10: Budget enforcement
      const policy = session.policy;
      const elapsedSec = (Date.now() - loopStartedAt) / 1000;
      if (policy.max_duration_seconds > 0 && elapsedSec > policy.max_duration_seconds) {
        const msg = `Session exceeded max_duration_seconds (${policy.max_duration_seconds}s)`;
        this.logger.warn(`Budget: ${msg}`);
        if (policy.pause_on_budget_hit) {
          session.status = 'paused';
          session.error = msg + ' — paused. Update policy and resume to continue.';
        } else {
          session.status = 'failed';
          session.error = msg;
        }
        session.updated_at = new Date().toISOString();
        this.persistSession(session);
        return;
      }
      const llmCalls = (session as any)._llm_calls || 0;
      if (policy.max_llm_calls && policy.max_llm_calls > 0 && llmCalls >= policy.max_llm_calls) {
        const msg = `Session exceeded max_llm_calls (${policy.max_llm_calls})`;
        this.logger.warn(`Budget: ${msg}`);
        if (policy.pause_on_budget_hit) {
          session.status = 'paused';
          session.error = msg + ' — paused. Update policy and resume.';
        } else {
          session.status = 'failed';
          session.error = msg;
        }
        session.updated_at = new Date().toISOString();
        this.persistSession(session);
        return;
      }
      const llmTokens = (session as any)._llm_tokens || 0;
      if (policy.max_llm_tokens && policy.max_llm_tokens > 0 && llmTokens >= policy.max_llm_tokens) {
        const msg = `Session exceeded max_llm_tokens (${policy.max_llm_tokens})`;
        this.logger.warn(`Budget: ${msg}`);
        if (policy.pause_on_budget_hit) {
          session.status = 'paused';
          session.error = msg + ' — paused. Update policy and resume.';
        } else {
          session.status = 'failed';
          session.error = msg;
        }
        session.updated_at = new Date().toISOString();
        this.persistSession(session);
        return;
      }

      // 1. Read current page/screen state
      let pageText = '';
      const isNativeMode = !!(session as any)?._native_app_mode;

      if (isNativeMode) {
        // Native app mode — capture EACH screen separately and describe with vision LLM
        // Multi-monitor: combined screenshot is too wide for the LLM to read properly
        const descriptions: string[] = [];

        // Ensure the target app is actually frontmost before capturing. Without
        // this, a foreground shift (e.g. System Preferences, Finder, another
        // agent's Electron window) causes every subsequent tick to screenshot
        // the wrong window — the VL describes it correctly but the agent
        // hallucinates that it's seeing the target app.
        const targetApp = (session as any)._native_app_mode;
        if (targetApp) {
          try {
            await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'focus_window', text: targetApp,
            }, { timeout: 4000 });
            // Give the window server a beat to settle after activation
            await new Promise(r => setTimeout(r, 250));
          } catch (err: any) {
            this.logger.debug(`Pre-capture focus on "${targetApp}" failed: ${err.message}`);
          }
        }

        try {
          const screensRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'list_screens',
          }, { timeout: 5000 });
          const screens = screensRes.data?.screens || [];

          for (const scr of screens) {
            try {
              // Capture this specific screen
              const ssRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'screenshot',
                screen_region: { x: scr.x, y: scr.y, width: scr.width, height: scr.height },
              }, { timeout: 10000 });
              const scrImage = ssRes.data?.screenshot;
              if (!scrImage || scrImage.length < 5000) {
                this.logger.debug(`Screen "${scr.name}": screenshot too small (${scrImage?.length || 0} chars)`);
                continue;
              }

              // Describe this screen with vision LLM
              this.logger.log(`Reading screen "${scr.name}" (${scrImage.length} chars)...`);
              const vRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
                user_message:
                  `Describe this screenshot of screen "${scr.name}" (${scr.width}x${scr.height}). ` +
                  `I'm looking for the "${(session as any)._native_app_mode}" app. ` +
                  `List ALL visible windows, apps, and clickable UI elements. Be thorough.`,
                context: {
                  system_override: 'Describe the screenshot thoroughly. List ALL visible apps and UI elements with their positions.',
                  max_tokens: 800,
                  screen_image: scrImage,
                },
              }, { timeout: 30000 }); // Increased timeout for large screenshots
              const desc = (vRes.data?.response_text || vRes.data?.response || '').trim();
              if (desc) {
                descriptions.push(`[Screen: ${scr.name}]\n${desc}`);
                this.logger.log(`Screen "${scr.name}": ${desc.length} chars description`);
              }
            } catch (scrErr: any) {
              this.logger.warn(`Failed to read screen "${scr.name}": ${scrErr.message}`);
            }
          }
        } catch { /* ignore list_screens failure */ }

        if (descriptions.length > 0) {
          pageText = `App: ${(session as any)._native_app_mode}\n\n${descriptions.join('\n\n')}`;
        } else {
          // Fallback: single combined screenshot
          const nativeScreen = await this.getScreenImage(sessionId);
          if (nativeScreen) {
            try {
              const visionRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
                user_message: `Describe this screenshot. List all visible UI elements.`,
                context: { system_override: 'Describe screenshot.', max_tokens: 800, screen_image: nativeScreen },
              }, { timeout: 20000 });
              const desc = (visionRes.data?.response_text || visionRes.data?.response || '').trim();
              if (desc) pageText = `App: ${(session as any)._native_app_mode}\n\n${desc}`;
            } catch { /* ignore */ }
          }
        }
      } else {
        // Browser mode — use Chrome Bridge with current tab hint
        const tabHint = (session as any)?._current_tab_hint || '';
        try {
          const pageRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'get_page_text', text: tabHint,
          }, { timeout: 15000 });
          if (pageRes.data?.success) {
            pageText = pageRes.data.output as string;
            // Update the tab hint from the actual URL we read
            const urlMatch = pageText.match(/^URL:\s*(.+)$/m);
            if (urlMatch) {
              try {
                const parsed = new URL(urlMatch[1].trim());
                (session as any)._current_tab_hint = parsed.hostname + parsed.pathname;
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
      }
      if (!pageText) {
        try {
          const ocrRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'ocr_screenshot',
          }, { timeout: 30000 });
          if (ocrRes.data?.success) pageText = ocrRes.data.output as string;
        } catch { /* ignore */ }
      }

      // Vision augment: when Chrome Bridge's DOM text is stale (React portals,
      // modals, shadow-DOM overlays are often missed), fall back to a VL
      // description of the screenshot so the agent can actually see modal /
      // dialog content. Gated on "DOM unchanged AFTER an active action that
      // should have changed state" so we don't burn VL calls on passive reads.
      if (!isNativeMode && pageText && prevPageText && pageText === prevPageText && actionHistory.length > 0) {
        const lastAct = actionHistory[actionHistory.length - 1] || '';
        const lastActionName = (lastAct.match(/\]\s*(\w+)|\.\s*(\w+)/)?.[1] || lastAct.match(/\.\s*(\w+)/)?.[1] || '').toLowerCase();
        const isActive = ['click', 'type', 'click_screen', 'key_press', 'submit', 'press'].some(a => lastAct.toLowerCase().includes(a));
        const isPassive = ['read_screen', 'wait', 'screenshot'].includes(lastActionName);
        if (isActive && !isPassive) {
          try {
            const screen = await this.getScreenImage(sessionId);
            if (screen && screen.length > 5000) {
              this.logger.log(`Vision augment: DOM stale after "${lastAct.slice(0, 60)}" — querying VL on screenshot`);
              const vRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
                user_message:
                  `The DOM text for this browser page is unchanged after the last action ` +
                  `("${lastAct.slice(0, 100)}"), but a modal/dialog/popover/dropdown may have ` +
                  `opened that the DOM reader cannot see (React portals, overlays). ` +
                  `Describe what is VISIBLE on screen right now. Focus on any modal, dialog, ` +
                  `popover, or dropdown. List clickable buttons, tabs, inputs, and icons with ` +
                  `their visible labels and approximate positions. Be concise — 20 lines max.`,
                context: {
                  system_override:
                    'Describe what is visible on the screen right now. Prioritize modals, ' +
                    'dialogs, popovers, and dropdowns. List UI elements with labels. 20 lines max.',
                  max_tokens: 600,
                  screen_image: screen,
                },
              }, { timeout: 25000 });
              const desc = (vRes.data?.response_text || vRes.data?.response || '').trim();
              if (desc) {
                pageText = pageText + `\n\n⚠️ VISION AUGMENT (DOM was stale after active action — this is what the screen actually shows):\n${desc}`;
                this.logger.log(`Vision augment: +${desc.length} chars from VL`);
              }
            }
          } catch (err: any) {
            this.logger.debug(`Vision augment failed: ${err.message}`);
          }
        }
      }

      // Page change detection
      let pageChangeNote = '';
      if (prevPageText && actionHistory.length > 0) {
        if (pageText === prevPageText) {
          pageChangeNote = '\n⚠️ PAGE UNCHANGED after last action. Try a different approach.\n';
        } else {
          const prevLines = new Set(prevPageText.split('\n').map(l => l.trim()).filter(Boolean));
          const newLines = pageText.split('\n').map(l => l.trim()).filter(l => l && !prevLines.has(l));
          if (newLines.length > 0) {
            pageChangeNote = `\n✓ PAGE CHANGED. New content:\n${newLines.slice(0, 10).join('\n')}\n`;
          }
        }
      }
      prevPageText = pageText;

      // Stuck detection — if recent actions failed or repeated with no effect
      let stuckNote = '';
      if (actionHistory.length >= 2) {
        // Check for repeated same action
        if (pageChangeNote.includes('UNCHANGED')) {
          const last2 = actionHistory.slice(-2);
          const sameAction = last2.every(h => {
            const m = h.match(/→\s*"([^"]+)"/);
            return m?.[1] && m[1] === (last2[0].match(/→\s*"([^"]+)"/)?.[1]);
          });
          if (sameAction) {
            stuckNote = `\n⚠️ STUCK: Same action repeated with no effect. You MUST use "navigate" with a direct URL instead of clicking. NEVER retry a failed click.\n`;
          }
        }
        // Check for consecutive click failures (timeout)
        const recentFails = actionHistory.slice(-3).filter(h => h.includes('ERROR') || h.includes('timeout'));
        if (recentFails.length >= 2) {
          stuckNote += `\n⚠️ ${recentFails.length} CONSECUTIVE CLICK FAILURES. STOP clicking — use "navigate" with a direct URL. ` +
            `Construct the URL: for GitHub issues use /issues, for a specific issue use /issues/NUMBER, for PRs use /pulls. ` +
            `For other sites, construct the path from what you know.\n`;
        }
      }

      // ── Mid-execution research: when stuck, search for how to proceed ──
      if (stuckNote && !(session as any)._mid_research_done) {
        try {
          const currentStepDesc = step.description || step.action || '';
          const stuckQuery = `how to ${currentStepDesc} step by step 2026`;
          this.logger.log(`Mid-execution research (stuck): "${stuckQuery}"`);
          const midResearch = await this.researchGoal(`${session.goal} — currently stuck on: ${currentStepDesc}. Screen shows: ${pageText.slice(0, 200)}`);
          if (midResearch) {
            researchCtx = midResearch;
            (session as any)._research = midResearch;
            (session as any)._mid_research_done = true;
            this.logger.log(`Mid-execution research: got ${midResearch.length} chars`);
          }
        } catch { /* research failed — continue without */ }
      }

      // Build remaining plan context
      const remainingSteps = session.plan
        .slice(session.current_step + 1)
        .filter(s => s.status === 'pending')
        .map((s, i) => `  ${session.current_step + 2 + i}. ${s.action}: ${s.description}`)
        .join('\n');

      // ── User interference check: pause if user is interacting ──
      try {
        const intfRes = await axios.get(
          `${DEV_AGENT_URL}/internal/dev-agent/cu-interference`, { timeout: 3000 },
        ).catch(() => null);

        if (intfRes?.data?.interference) {
          this.logger.log(`User interference detected — pausing session ${sessionId}`);
          session.status = 'paused';
          session.error = 'User interference detected — will resume when you stop interacting';
          session.updated_at = new Date().toISOString();

          // Wait for user to stop (poll every 2s)
          let waitCount = 0;
          while (session.status === 'paused' && waitCount < 60) { // max 2 minutes
            await new Promise(r => setTimeout(r, 2000));
            waitCount++;
            // Check if session was cancelled while waiting (status changed by cancel endpoint)
            if ((session.status as string) === 'cancelled') {
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/cu-interference/stop`).catch(() => {});
              return;
            }
            const check = await axios.get(
              `${DEV_AGENT_URL}/internal/dev-agent/cu-interference`, { timeout: 3000 },
            ).catch(() => null);
            if (check?.data && !check.data.interference) {
              // User stopped — short delay then resume
              await new Promise(r => setTimeout(r, 1000));
              session.status = 'executing';
              session.error = undefined;
              session.updated_at = new Date().toISOString();
              this.logger.log(`User interference cleared after ${waitCount * 2}s — resuming with fresh screen read`);
              break;
            }
          }
          if (session.status === 'paused') {
            // Timed out waiting — resume anyway
            session.status = 'executing';
            session.error = undefined;
          }
          continue; // Re-read screen state at top of loop
        }
      } catch { /* interference check failed — continue normally */ }

      // 2. Decide: execute as-is (skill plan) or ask LLM to adapt?
      step.status = 'running';
      step.started_at = new Date().toISOString();
      session.updated_at = new Date().toISOString();

      // 2. Ask the LLM: should we execute this step as-is, adapt, or skip?
      // Even for skill-sourced plans, the LLM validates each step against the current screen.
      // Skills provide the PLAN (fast, no LLM planning call), but each step is still validated.
      const isSkillPlan = !!(session as any)._active_skill_id;
      const matchedHandcraftedSkills: string[] = (session as any)._matched_skills || [];
      const hasHandcraftedSkill = matchedHandcraftedSkills.length > 0;
      const skillHint = (isSkillPlan || hasHandcraftedSkill)
        ? `\nNOTE: This plan comes from a ${isSkillPlan ? 'LEARNED SKILL with a proven success rate' : `HAND-CRAFTED SKILL (${matchedHandcraftedSkills.join(', ')})`}. ` +
          `Prefer executing the planned step as-is unless the screen clearly shows it won't work. ` +
          `Do NOT change the action type unless absolutely necessary. ` +
          `In particular, do NOT rewrite a planned "read_screen" / "scroll" / "wait" step into a "click" ` +
          `just because salient text is visible — the plan intentionally reads/scrolls first to orient, ` +
          `then clicks a specific target later.\n`
        : '';

      // Build progress overview — what's been done and what's left
      const completedSummary = session.plan
        .filter(s => s.status === 'completed' && s.action !== 'read_screen')
        .map(s => `  ✓ ${s.action}: ${(s.description || '').slice(0, 60)}`)
        .join('\n');
      const progressOverview = completedSummary
        ? `\nPROGRESS SO FAR:\n${completedSummary}\n`
        : '';

      // ── Durable memory context: load MEMORY.md + SCRATCH.md + USER_NOTES.md ──
      // Agent has full visibility of facts learned, drafts saved, and user instructions.
      const sessionMem = new SessionMemory(sessionId);
      const [memoryMd, scratchMd, userNotesMd] = await Promise.all([
        sessionMem.loadMemory().catch(() => ''),
        sessionMem.loadScratch().catch(() => ''),
        sessionMem.read('USER_NOTES.md').catch(() => ''),
      ]);
      const memoryBlock = memoryMd ? `\nMEMORY (facts from prior steps):\n${memoryMd.slice(0, 3000)}\n` : '';
      const scratchBlock = scratchMd
        ? `\nSCRATCH (your working draft — USE THIS when typing saved content):\n${scratchMd.slice(0, 3000)}\n`
        : '';
      const userNotesBlock = userNotesMd
        ? `\n⚠️ USER NOTES (instructions the user left for you — FOLLOW THESE):\n${userNotesMd.slice(0, 2000)}\n`
        : '';

      // Show the most recent drift-guard rejection (if any) so the LLM can
      // actually avoid repeating the same rejected proposal next turn.
      const lastRejection = (session as any)?._last_rejection as string | undefined;
      const rejectionBlock = lastRejection
        ? `\n⚠️ YOUR PREVIOUS PROPOSAL WAS REJECTED BY THE DRIFT GUARD:\n${lastRejection}\n` +
          `Re-propose a DIFFERENT action that addresses this rejection. Do NOT repeat the ` +
          `same (action, target). If no valid action exists, use ACTION: failed with a ` +
          `short reason.\n\n`
        : '';

      const userPrompt =
        `GOAL: ${session.goal}\n\n` +
        (researchCtx ? `RESEARCH:\n${researchCtx.slice(0, 1500)}\n\n` : '') +
        lessonsCtx +
        skillHint +
        userNotesBlock +
        rejectionBlock +
        progressOverview +
        memoryBlock +
        scratchBlock +
        (actionHistory.length > 0 ? `RECENT ACTIONS:\n${actionHistory.slice(-5).join('\n')}\n\n` : '') +
        `CURRENT PLANNED STEP (${session.current_step + 1}/${session.plan.length}):\n` +
        `  Action: ${step.action}\n` +
        `  Target: ${step.target || '(none)'}\n` +
        ((step as any).anchor ? `  Anchor: ${(step as any).anchor}\n` : '') +
        `  Description: ${step.description}\n\n` +
        (remainingSteps ? `REMAINING PLAN:\n${remainingSteps}\n\n` : '') +
        pageChangeNote +
        stuckNote +
        `CURRENT PAGE:\n${pageText.slice(0, 5000)}\n\n` +
        `IMPORTANT: Focus on the REMAINING plan steps. Do NOT repeat actions already completed above. ` +
        `If a tab or page was already opened, use switch_tab to return to it instead of re-navigating. ` +
        `When you have a long draft to type, use scratch_write to save it first, then reference SCRATCH.md when it's time to type.\n\n` +
        `Should the planned step be executed as-is, adapted, or skipped?`;

      // ── Action-pinning: deterministic planned actions skip the LLM adaptation loop.
      //
      // read_screen / read_page / wait / key_press don't need visual validation —
      // the plan specifies exactly what to do, and the action doesn't depend on
      // resolving any ambiguous target against the current screen.
      //
      // Running the adaptive LLM for these steps wastes a call AND, more
      // importantly, gives the LLM a chance to rewrite the planned action into a
      // click on something visually salient (observed failure mode on Facebook:
      // every read_screen / scroll step got rewritten into click → <post title
      // text> because the large post-text region dominated the screen).
      //
      // NOTE: `scroll` is INTENTIONALLY NOT pinned. In search/locate loops the
      // planner emits several scroll-wait-read_screen cycles in a row — and the
      // LLM needs the chance to bail out of those cycles when read_screen shows
      // the target is already visible. Pinning scroll caused the agent to
      // overshoot past target posts that were already in view after 1–2 cycles.
      // The skillHint ("do not rewrite a planned scroll into a click") stays in
      // place to block the original failure mode without trapping the loop.
      const PINNED_ACTION_TYPES = new Set(['read_screen', 'read_page', 'wait', 'key_press']);
      // When a hand-crafted skill is active, ALSO pin click/click_scoped steps
      // that have a specific named target. The skill's planGuidance chose that
      // target for a reason (e.g. "Edit post" for the menu item, "Actions for
      // this post" for the three-dot menu). Letting the LLM re-adapt these
      // almost always converts them into a different target that doesn't advance
      // the plan (observed: "Edit post" → "Actions for this post" re-opens the
      // menu instead of clicking Edit, every single run). Chrome Bridge
      // click_element handles text-match resolution; if the click fails, the
      // step fails cleanly — which is better than silently substituting a
      // wrong target that appears to succeed but doesn't produce the expected
      // UI state.
      const isSkillPinnedClick =
        hasHandcraftedSkill &&
        (step.action === 'click' || step.action === 'click_scoped') &&
        !!step.target;
      const actionIsPinned =
        PINNED_ACTION_TYPES.has(step.action.toLowerCase()) || isSkillPinnedClick;

      let llmResponse = '';
      if (actionIsPinned) {
        this.logger.log(
          `Step ${session.current_step + 1}: pinning planned action "${step.action}"` +
          `${step.target ? ` → ${step.target.slice(0, 40)}` : ''} (deterministic — skipping LLM adaptation)`,
        );
        // Simulate what the REACT LLM would have returned for "run the plan as-is".
        // The downstream parser reads THOUGHT/ACTION/TARGET lines from this string.
        llmResponse = `THOUGHT: deterministic planned action — pinned by action-pinning rule\n` +
          `ACTION: execute_plan\n` +
          `TARGET: ${step.target || ''}`;
        (session as any)._llm_calls_saved = ((session as any)._llm_calls_saved || 0) + 1;
      } else {
        try {
          // Text-only adaptive decisions (no screenshot) use DeepSeek for better
          // instruction following. Vision calls (with screen_image) use the VL model.
          const cuTextModel = process.env.OASIS_TOOL_PLAN_LLM_MODEL || 'deepseek-v3.2';
          const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
            user_message: userPrompt,
            context: { system_override: ComputerUseController.REACT_SYSTEM, max_tokens: 512, model_override: cuTextModel },
          }, { timeout: LLM_TIMEOUT_MS });
          llmResponse = res.data?.response_text || res.data?.response || '';
          // Phase 10: Track budget
          (session as any)._llm_calls = ((session as any)._llm_calls || 0) + 1;
          if (res.data?.usage?.total_tokens) {
            (session as any)._llm_tokens = ((session as any)._llm_tokens || 0) + res.data.usage.total_tokens;
          }
        } catch (err: any) {
          this.logger.error(`Adaptive LLM failed: ${err.message}`);
          step.status = 'failed';
          step.output = `LLM error: ${err.message}`;
          step.completed_at = new Date().toISOString();
          session.current_step++;
          continue;
        }
      }

      // 3. Parse response
      const thought = llmResponse.match(/THOUGHT:\s*(.+)/i)?.[1]?.trim() || '';
      let action = (llmResponse.match(/ACTION:\s*(\S+)/i)?.[1] || 'execute_plan')
        .trim().toLowerCase().replace(/^["']+|["']+$/g, ''); // Strip quotes from action name
      let target = (llmResponse.match(/TARGET:\s*(.+)/i)?.[1] || '')
        .trim().replace(/^["']+|["']+$/g, ''); // Strip wrapping quotes from target
      // click_scoped supplies ANCHOR: <container-identifying substring> on an
      // extra line. Parse it now so downstream executeComputerAction can read
      // it off step.anchor (set alongside step.action/target below).
      const llmAnchor = (llmResponse.match(/ANCHOR:\s*(.+)/i)?.[1] || '')
        .trim().replace(/^["']+|["']+$/g, '');

      this.logger.log(`Step ${session.current_step + 1} [${action}]: ${thought.slice(0, 100)} | target: ${target.slice(0, 60)}`);
      // Store the LLM's thought as context but keep the original step description
      // so the plan shows what the step IS, not the LLM's running commentary/claims.
      (step as any)._thought = thought || '';
      // Only update description if it was empty (e.g., auto-generated check steps)
      if (!step.description && thought) {
        step.description = thought;
      }

      // 4. Handle the decision
      if (action === 'done') {
        // Verify the goal was ACTUALLY achieved before marking done
        const goalVerified = await this.checkGoalSatisfaction(sessionId, session.goal, session.plan);
        if (!goalVerified) {
          consecutiveGoalRejections++;
          this.logger.warn(`LLM "done" rejected (${consecutiveGoalRejections}/3) — goal not verified`);

          // After 3 consecutive rejections, accept the result as-is to avoid infinite loops
          if (consecutiveGoalRejections >= 3) {
            this.logger.warn(`Goal verification failed 3 times — completing session as-is`);
            // Fall through to the completion handler below
          } else {
            step.description = `Goal verification failed: ${target}`;
            actionHistory.push(`${session.current_step + 1}. DONE_REJECTED: goal not verified (${consecutiveGoalRejections}/3)`);
            session.current_step++;
            session.updated_at = new Date().toISOString();
            extraStepsUsed++;
            if (session.current_step >= session.plan.length && extraStepsUsed < MAX_EXTRA_STEPS) {
              session.plan.push({
                index: session.plan.length,
                description: 'Previous done claim was rejected — retrying goal...',
                action: 'read_screen',
                target: '',
                status: 'pending',
                _auto: true,
              } as any);
            }
            continue;
          }
        }
        consecutiveGoalRejections = 0; // Reset on verified success

        step.status = 'completed';
        step.output = target;
        step.completed_at = new Date().toISOString();
        // Mark remaining steps as skipped
        for (const s of session.plan.slice(session.current_step + 1)) {
          if (s.status === 'pending') s.status = 'skipped';
        }
        session.status = 'completed';
        session.updated_at = new Date().toISOString();
        this.logger.log(`Goal VERIFIED and achieved at step ${session.current_step + 1}: ${target}`);
        this.generateSessionSummary(sessionId).catch(() => {});
        // Learn from successful session — store what worked as a rule (logic engine)
        this.learnFromSession(session).catch(() => {});
        // Create reusable skill from the completed steps (learning memory)
        this.createSkillFromSession(session).catch(() => {});
        // Update skill stats if we were using a learned skill
        if ((session as any)._active_skill_id) {
          axios.patch(
            `${MEMORY_URL}/internal/memory/cu/skill/${(session as any)._active_skill_id}/stats`,
            { success: true },
            { timeout: 5000 },
          ).catch(() => {});
        }
        return;
      }

      if (action === 'failed') {
        step.status = 'failed';
        step.output = target;
        step.completed_at = new Date().toISOString();
        session.status = 'failed';
        session.error = target;
        session.updated_at = new Date().toISOString();
        this.generateSessionSummary(sessionId).catch(() => {});
        // Degrade skill stats on failure
        if ((session as any)._active_skill_id) {
          axios.patch(
            `${MEMORY_URL}/internal/memory/cu/skill/${(session as any)._active_skill_id}/stats`,
            { success: false },
            { timeout: 5000 },
          ).catch(() => {});
        }
        return;
      }

      if (action === 'skip') {
        step.status = 'skipped';
        step.output = target;
        step.completed_at = new Date().toISOString();
        actionHistory.push(`${session.current_step + 1}. SKIP: ${target.slice(0, 80)}`);
        session.current_step++;
        session.updated_at = new Date().toISOString();
        continue;
      }

      // ── Memory actions: scratch_write, scratch_append, fact ─────────────
      // These don't need a plan step to consume — they're meta-actions that
      // persist to the session's durable memory. They do NOT advance current_step
      // because they're orthogonal to the plan's progress; the LLM can keep
      // executing the actual planned step next iteration.
      if (action === 'scratch_write') {
        const mem = new SessionMemory(sessionId);
        await mem.writeScratch(target);
        actionHistory.push(`${session.current_step + 1}. SCRATCH_WRITE (${target.length} chars)`);
        this.logger.log(`Session ${sessionId}: wrote SCRATCH.md (${target.length} chars)`);
        continue;
      }
      if (action === 'scratch_append') {
        const mem = new SessionMemory(sessionId);
        const current = await mem.loadScratch();
        await mem.writeScratch(current + (current ? '\n\n' : '') + target);
        actionHistory.push(`${session.current_step + 1}. SCRATCH_APPEND (${target.length} chars)`);
        continue;
      }
      if (action === 'fact') {
        this.recordFact(sessionId, target);
        actionHistory.push(`${session.current_step + 1}. FACT: ${target.slice(0, 80)}`);
        continue;
      }

      // 5. Guard: if LLM keeps choosing switch_tab instead of executing the plan,
      // force the planned action after 2 consecutive switch_tab attempts.
      const recentSwitchTabs = actionHistory.slice(-2).filter(h => h.includes('switch_tab')).length;
      if (action === 'switch_tab' && recentSwitchTabs >= 2) {
        this.logger.warn(`Overriding LLM switch_tab (${recentSwitchTabs + 1}x) — forcing planned action: ${step.action}`);
        action = 'execute_plan';
        target = step.target || '';
      }

      // Execute — either the planned step or an adapted action
      const execAction = action === 'execute_plan' ? step.action : action;
      const execTarget = action === 'execute_plan' ? (step.target || '') : target;

      // ── Drift guard: validate the resolved (action, target) before execution. ──
      // Rejects destructive clicks, post-body-text drift when a skill is active,
      // and silent action-type swaps on pinned plan steps. On rejection we do NOT
      // execute; we loop back and re-ask the LLM with the rejection reason.
      // Sessions that rack up too many rejections are failed outright to prevent
      // indefinite drift loops.
      const validation = this.validateProposedAction(
        step,
        { action: execAction, target: execTarget },
        session,
        matchedHandcraftedSkills,
      );
      if (!validation.ok) {
        const prev = ((session as any)._action_rejections || 0);
        const rejections = prev + 1;
        (session as any)._action_rejections = rejections;
        const MAX_SESSION_REJECTIONS = 5;
        this.logger.warn(
          `Rejected proposed action [${execAction}${execTarget ? ` → ${execTarget.slice(0, 60)}` : ''}] ` +
          `(${rejections}/${MAX_SESSION_REJECTIONS}): ${validation.reason}`,
        );
        actionHistory.push(
          `${session.current_step + 1}. REJECTED [${execAction}${execTarget ? ` "${execTarget.slice(0, 40)}"` : ''}]: ${(validation.reason || '').slice(0, 120)}`,
        );
        // Make the rejection visible to the next LLM call via the userPrompt builder.
        (session as any)._last_rejection = validation.reason;

        if (rejections >= MAX_SESSION_REJECTIONS) {
          // Instead of failing the session outright, FORCE-EXECUTE the planned
          // action one last time. The LLM has clearly lost the thread, but the
          // plan itself may still be sound — e.g. it kept proposing
          // switch_tab/navigate to re-read source data when it should just type
          // (the typing path's composition pass already pulls collected data).
          // If the forced execution genuinely doesn't work, the next loop
          // iteration will surface a real failure (timeout, element not found)
          // instead of a synthetic "drift" failure that masks what actually
          // would have happened.
          this.logger.warn(
            `Session ${sessionId}: hit ${MAX_SESSION_REJECTIONS} rejections — force-executing planned action ${step.action}${step.target ? ` → ${step.target.slice(0, 60)}` : ''} as last resort instead of failing.`,
          );
          actionHistory.push(
            `${session.current_step + 1}. FORCE-EXECUTE planned ${step.action} after ${rejections} rejections`,
          );
          (session as any)._action_rejections = 0; // reset so we don't insta-fail next step
          (session as any)._last_rejection = null;
          // Fall through into the normal execute path with the planned action.
          // We do this by re-binding action/target to the plan and clearing the
          // validation reject so the rest of the loop body runs as if the LLM
          // had said execute_plan from the start.
          // (action and target are mutated to mirror what execute_plan resolves to)
          // eslint-disable-next-line no-param-reassign
          // @ts-ignore – action/target are mutated in this large loop
          action = 'execute_plan';
          // @ts-ignore
          target = step.target || '';
        } else {
          // Don't advance the step, don't mutate step.action/target — loop back
          // to get a fresh LLM proposal with the rejection reason in context.
          continue;
        }
      }
      // Valid action — clear the last-rejection hint so it doesn't linger in
      // prompts for future independent steps.
      (session as any)._last_rejection = undefined;

      // Update the step to reflect what we're actually doing
      if (action !== 'execute_plan') {
        step.action = execAction;
        step.target = execTarget;
        // Reflect the adapted action in the visible description so the
        // overlay shows what the agent is ACTUALLY doing, not the original
        // plan text. Without this, the user sees "Open Facebook composer"
        // while the agent is actually doing switch_tab to GitHub.
        // Only annotate once — subsequent re-substitutions on the same
        // step keep the original description intact (avoids "→ adapted: X
        // → adapted: Y" pile-ups).
        const baseDesc = (step as any)._original_description ?? step.description ?? '';
        if (!(step as any)._original_description) {
          (step as any)._original_description = baseDesc;
        }
        const tgtPreview = execTarget ? ` "${execTarget.slice(0, 40)}${execTarget.length > 40 ? '…' : ''}"` : '';
        step.description = `${baseDesc} → adapted: ${execAction}${tgtPreview}`;
        // Capture the LLM-supplied anchor for click_scoped. Plan-level
        // anchors (from the skill's planGuidance emitted by draftPlan)
        // remain intact when action === 'execute_plan'.
        if (execAction === 'click_scoped' && llmAnchor) {
          (step as any).anchor = llmAnchor;
        }
      }

      try {
        const result = await this.executeComputerAction(
          { ...step, action: execAction, target: execTarget } as PlanStep,
          sessionId,
        );

        step.status = 'completed';
        step.output = result.output;
        step.completed_at = new Date().toISOString();
        if (result.screenshot) session.live_screenshot = result.screenshot;

        actionHistory.push(`${session.current_step + 1}. ${execAction}${execTarget ? ` → "${execTarget.slice(0, 50)}"` : ''} → ${result.output.slice(0, 80)}`);

        // Durable per-step history: write FULL output to memory/NNN-action.md
        this.persistStep(sessionId, step, {
          thought: (step as any)._thought || thought,
          before: pageText ? pageText.slice(0, 2000) : undefined,
        });

        // Record concrete facts to MEMORY.md based on action type
        if (execAction === 'type' && execTarget) {
          this.recordFact(sessionId, `Typed: "${execTarget.slice(0, 300)}"`);
        } else if (execAction === 'navigate' && execTarget) {
          this.recordFact(sessionId, `Navigated to: ${execTarget}`);
        } else if (execAction === 'click' && result.output && !result.output.includes('timeout')) {
          this.recordFact(sessionId, `Clicked: "${execTarget.slice(0, 100)}"`);
        } else if (execAction === 'read_screen' || execAction === 'read_page') {
          const m = result.output.match(/^URL:\s*(.+)$/m);
          if (m) this.recordFact(sessionId, `Read page: ${m[1].trim()}`);
        }

        // ── CU Learning: save action + UI element to memory (fire-and-forget) ──
        const uiElemId = await this.saveUIElementToMemory(
          execTarget.slice(0, 100), execAction, 0, 0, pageText.slice(0, 100),
        ).catch(() => null);
        if (uiElemId) {
          const ids: string[] = (session as any)._ui_element_ids || [];
          ids.push(uiElemId);
          (session as any)._ui_element_ids = ids;
        }
        this.saveActionToMemory(
          execAction, execTarget, step.status === 'completed',
          pageText.slice(0, 100), uiElemId || undefined,
          (session as any)._active_skill_id,
        ).catch(() => {});

        // After open_app succeeds, trust the plan — advance immediately without
        // re-asking the LLM (which often misidentifies the app and retries open_app)
        if (execAction === 'open_app') {
          step.status = 'completed';
          step.completed_at = new Date().toISOString();
          session.current_step++;
          session.updated_at = new Date().toISOString();
          this.logger.log(`open_app succeeded → auto-advancing to step ${session.current_step + 1}`);
          await new Promise(r => setTimeout(r, 2000)); // Wait for app to fully launch and settle
          continue; // skip the rest of this iteration's logic, proceed to next planned step
        }

        // Discovery extraction
        if ((execAction === 'read_screen' || execAction === 'read_page') && result.output) {
          await this.replaceDiscoveryTokens(session, step);
        }

        // 2FA detection — restrict to user-facing page content, not URLs/tab titles.
        // Previous matcher false-positived on URL-encoded "%2Fa" inside OAuth redirect URLs
        // (e.g. AMD's `redirect_uri=https%3A%2F%2Fdeveloper.amd.com%2Fauth` matches /2fa/i).
        // The read-screen output structure is:
        //   URL: ... \n Title: ... \n\n Open tabs:\n[urls]\n\n Page content:\n[text]
        // We extract the Page content section and use word-boundaried tokens to avoid
        // matching arbitrary substrings.
        const pageContentMatch = result.output.match(/\nPage content:\n([\s\S]*?)$/);
        const verifyHaystack = pageContentMatch ? pageContentMatch[1] : result.output;
        const VERIFICATION_PATTERNS = [
          /\btwo[-\s]step verification\b/i,
          /\btwo[-\s]factor authentication\b/i,
          /\b2fa\b/i,
          /\benter (?:the |your )?(?:verification|security|confirmation) code\b/i,
          /\bconfirm your identity\b/i,
          /\bcaptcha\b/i,
          /\brecaptcha\b/i,
        ];
        if (VERIFICATION_PATTERNS.some(p => p.test(verifyHaystack))) {
          session.status = 'awaiting_credential';
          session.error = 'Verification required (2FA / captcha / identity check). Complete it in the browser, then resume.';
          session.updated_at = new Date().toISOString();
          this.persistSession(session);
          // Write a human-readable handoff so the user knows what's needed
          new SessionMemory(sessionId).write('HANDOFF.md',
            `# Credential needed — ${new Date().toISOString()}\n\n` +
            `The website is asking for verification (2FA, captcha, or identity confirmation).\n\n` +
            `**What to do:**\n` +
            `1. Complete the verification in the browser yourself.\n` +
            `2. Then POST /sessions/${sessionId}/resume to continue.\n` +
            `3. Optionally, POST /sessions/${sessionId}/user-note with instructions first.\n`,
          ).catch(() => {});
          return;
        }
      } catch (err: any) {
        step.status = 'failed';
        step.output = err.message;
        step.completed_at = new Date().toISOString();
        actionHistory.push(`${session.current_step + 1}. ${execAction} → ERROR: ${err.message.slice(0, 60)}`);
        // Durable per-step history for failed steps too
        this.persistStep(sessionId, step, {
          thought: (step as any)._thought || thought,
          before: pageText ? pageText.slice(0, 2000) : undefined,
        });
      }

      session.current_step++;
      session.updated_at = new Date().toISOString();

      // Track consecutive passive steps (no real progress: navigate, read, scroll, open_app).
      // System-appended steps (`_auto: true`) are forced verification probes, not LLM stalling —
      // they're already bounded by MAX_EXTRA_STEPS and must not be counted here, otherwise a
      // successful plan that ends with the auto-verify phase will be falsely killed as "stuck".
      const passiveActions = ['read_screen', 'read_page', 'scroll', 'navigate', 'switch_tab', 'open_app'];
      if (!(step as any)._auto) {
        if (passiveActions.includes(execAction)) {
          consecutiveReadScreens++;
        } else {
          consecutiveReadScreens = 0;
        }
      }

      // If 6 consecutive passive steps without a real action (click/type) → agent is stuck, FAIL
      if (consecutiveReadScreens >= 6) {
        this.logger.warn(`Agent stuck: ${consecutiveReadScreens} consecutive passive steps (navigate/read/scroll) — marking FAILED`);
        session.status = 'failed';
        session.error = 'Agent stopped making progress — repeated navigation/reading without performing the requested action (no clicks or typing).';
        session.updated_at = new Date().toISOString();
        this.generateSessionSummary(sessionId).catch(() => {});
        return;
      }

      // If we've run out of planned steps but the goal might not be done,
      // add one final check step. Tag as `_auto` so the stuck-loop detector
      // doesn't count these system-forced verification reads as agent stalling.
      if (session.current_step >= session.plan.length && extraStepsUsed < MAX_EXTRA_STEPS) {
        session.plan.push({
          index: session.plan.length,
          description: 'Checking if goal is achieved...',
          action: 'read_screen',
          target: '',
          status: 'pending',
          _auto: true,
        } as any);
        extraStepsUsed++;
      }

      // Durable snapshot at the end of each loop iteration
      this.persistSession(session);

      await new Promise(r => setTimeout(r, 500));
    }

    // All steps done — stop interference monitor
    await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/cu-interference/stop`).catch(() => {});

    if (session.status === 'executing') {
      // Before marking complete, verify the goal was actually achieved.
      // Detect "no real action" patterns: if the agent only navigated/read
      // without ever clicking or typing, it likely didn't accomplish the goal.
      const realActions = session.plan.filter(s =>
        s.status === 'completed' &&
        s.action && !['navigate', 'read_screen', 'read_page', 'scroll', 'screenshot', 'switch_tab', 'open_app', 'wait'].includes(s.action),
      );
      const goalSatisfied = await this.checkGoalSatisfaction(sessionId, session.goal, session.plan);

      if (!goalSatisfied) {
        this.logger.warn(`All steps done but goal NOT satisfied (${realActions.length} real actions). Marking FAILED.`);
        session.status = 'failed';
        session.error = realActions.length === 0
          ? 'Agent completed all steps but never performed the requested action (no clicks or typing occurred).'
          : 'Agent completed all steps but the goal was not verified as achieved.';
      } else {
        session.status = 'completed';
      }
      session.updated_at = new Date().toISOString();
      this.generateSessionSummary(sessionId).catch(() => {});
    }
  }

  /**
   * Execute plan steps using an agentic loop per step (legacy linear mode).
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

        // ── 2FA / verification detection: pause and ask user for help ──
        const VERIFICATION_PATTERNS = [
          /two.step.verification/i,
          /two.factor.auth/i,
          /2fa/i,
          /verification.code/i,
          /enter.the.code/i,
          /security.check/i,
          /confirm.your.identity/i,
          /\/checkpoint\//i,
          /captcha/i,
          /verify.it.?s.you/i,
          /login.approval/i,
        ];
        if (VERIFICATION_PATTERNS.some(p => p.test(output))) {
          this.logger.log(`Step ${step.index + 1} detected verification/2FA page — pausing for user`);
          session.status = 'paused';
          session.error = 'The website requires verification (2FA, captcha, or identity check). Please complete it in the browser, then resume the session.';
          session.updated_at = new Date().toISOString();
          return;
        }

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

    // ── EVIDENCE-BASED SUMMARY: built from ACTUAL step outputs only ──
    // No LLM involved in determining what happened. The LLM only polishes wording.

    const completedSteps = session.plan.filter(s => s.status === 'completed');
    const failedSteps = session.plan.filter(s => s.status === 'failed');

    // Extract concrete evidence from step outputs
    const typedContent = session.plan
      .filter(s => s.action === 'type' && s.status === 'completed' && s.output)
      .map(s => {
        const m = (s.output || '').match(/^Typed:\s*(.+)/i);
        return m ? m[1].trim() : '';
      })
      .filter(t => t.length > 5);

    const clickedElements = session.plan
      .filter(s => s.action === 'click' && s.status === 'completed' && s.output)
      .filter(s => !(s.output || '').includes('timeout'))
      .map(s => (s.output || '').slice(0, 80));

    const readScreenData = session.plan
      .filter(s => (s.action === 'read_screen' || s.action === 'read_page') && s.status === 'completed' && s.output)
      .map(s => s.output!)
      .slice(-2);

    const navigatedUrls = session.plan
      .filter(s => s.action === 'navigate' && s.status === 'completed' && s.output)
      .map(s => {
        const m = (s.output || '').match(/^URL:\s*(.+)/m);
        return m ? m[1].trim() : (s.output || '').slice(0, 60);
      });

    // Build factual evidence summary
    const evidence: string[] = [];
    if (navigatedUrls.length > 0) {
      const uniqueUrls = [...new Set(navigatedUrls)].slice(0, 5);
      evidence.push(`Visited: ${uniqueUrls.join(', ')}`);
    }
    if (typedContent.length > 0) {
      evidence.push(`Typed: "${typedContent.map(t => t.slice(0, 100)).join('", "')}"`);
    }
    if (clickedElements.length > 0) {
      evidence.push(`Clicked: ${clickedElements.length} elements`);
    }
    if (failedSteps.length > 0) {
      evidence.push(`Failed: ${failedSteps.map(s => `"${s.action}" (${(s.output || '').slice(0, 50)})`).join(', ')}`);
    }

    // Determine status from hard evidence
    const isFailed = session.status === 'failed';
    const goalLower = session.goal.toLowerCase();
    const goalNeedsPost = /\b(post|publish|share|send|create.*post)\b/.test(goalLower);
    const goalNeedsType = /\b(post|write|type|create|compose)\b/.test(goalLower);
    const hasTypedPost = typedContent.some(t => t.length > 20 && !t.startsWith('http'));
    const clickedPost = clickedElements.some(o => /post|publish|share|send/i.test(o));

    let statusLine: string;
    if (isFailed) {
      statusLine = `❌ **Task failed**: ${session.error || 'Unknown error'}`;
    } else if (goalNeedsPost && !clickedPost) {
      statusLine = `⚠️ **Partial**: Content may have been typed but the Post/Publish button was not confirmed as clicked.`;
    } else if (goalNeedsType && !hasTypedPost) {
      statusLine = `⚠️ **Partial**: The required text content was not typed.`;
    } else {
      statusLine = `✅ **Task completed**`;
    }

    // Build the summary WITHOUT LLM — pure evidence
    const evidenceBlock = evidence.length > 0
      ? `\n\n**What was done:**\n${evidence.map(e => `- ${e}`).join('\n')}`
      : '\n\nNo actions were performed.';

    const readDataBlock = readScreenData.length > 0
      ? `\n\n**Data read from screen:**\n${readScreenData.map(d => d.slice(0, 500)).join('\n---\n')}`
      : '';

    const factualSummary = `${statusLine}${evidenceBlock}${readDataBlock}`;

    // Optionally let LLM polish the wording but ONLY using the factual content above
    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message:
          `Rewrite this factual summary in a friendly, concise way. Do NOT add any information that is not already present. Do NOT invent content.\n\n` +
          `GOAL: ${session.goal}\n\n` +
          `FACTUAL SUMMARY:\n${factualSummary}\n\n` +
          `Rewrite concisely. Keep the status emoji. Keep all evidence. Do not add anything new.`,
        context: {
          system_override: 'Rewrite the given factual summary concisely. Do NOT add information. Do NOT invent results.',
          max_tokens: 512,
        },
      }, { timeout: 15000 });

      const polished = (res.data?.response_text || res.data?.response || '').trim();
      // Sanity check: if the polished version is much longer than the factual one, it added content
      if (polished && polished.length < factualSummary.length * 2) {
        (session as any).summary = polished;
      } else {
        (session as any).summary = factualSummary;
      }
    } catch {
      // LLM failed — use the raw factual summary
      (session as any).summary = factualSummary;
    }
    session.updated_at = new Date().toISOString();
    this.persistSession(session);
    this.logger.log(`Session ${sessionId} summary generated (${((session as any).summary || '').length} chars)`);

    // Phase 4: Promote session memory to artifact service for cross-session retrieval.
    // Only promote successful/completed sessions — failed sessions with empty memory
    // don't teach us anything useful.
    if (session.status === 'completed') {
      const projectId = (session as any)._project_id || undefined;
      promoteSessionToArtifacts(sessionId, session.goal, projectId)
        .then(artifactId => {
          if (artifactId) {
            this.logger.log(`Session ${sessionId} memory promoted to artifact ${artifactId}`);
          }
        })
        .catch(err => {
          this.logger.debug(`Failed to promote session ${sessionId} to artifacts: ${err.message}`);
        });
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
    // ── Hard pre-checks: detect patterns that indicate definite failure ──
    const completedSteps = plan.filter(s => s.status === 'completed');
    const failedSteps = plan.filter(s => s.status === 'failed');

    // Check for looping: if the same action+description repeats 3+ times, agent was stuck
    const actionCounts = new Map<string, number>();
    for (const s of completedSteps) {
      const key = `${s.action}|${(s.description || '').slice(0, 40)}`;
      actionCounts.set(key, (actionCounts.get(key) || 0) + 1);
    }
    const maxRepeat = Math.max(0, ...actionCounts.values());
    if (maxRepeat >= 3) {
      this.logger.warn(`Goal check: REJECTED — same action repeated ${maxRepeat} times (looping pattern)`);
      return false;
    }

    // Check for high failure ratio: if >40% of steps failed, goal unlikely satisfied
    if (completedSteps.length + failedSteps.length >= 4) {
      const failRatio = failedSteps.length / (completedSteps.length + failedSteps.length);
      if (failRatio > 0.4) {
        this.logger.warn(`Goal check: REJECTED — ${failedSteps.length}/${completedSteps.length + failedSteps.length} steps failed (${(failRatio * 100).toFixed(0)}%)`);
        return false;
      }
    }

    // ── Evidence-based action checks ──
    const goalLower = goal.toLowerCase();

    // Extract what ACTUALLY happened from step outputs
    const typedContent = completedSteps
      .filter(s => s.action === 'type' && s.output)
      .map(s => { const m = (s.output || '').match(/^Typed:\s*(.+)/i); return m ? m[1] : ''; })
      .filter(t => t.length > 5);

    const clickedOutputs = completedSteps
      .filter(s => s.action === 'click' && s.output && !(s.output || '').includes('timeout'))
      .map(s => (s.output || ''));

    // Goal requires posting → must have typed content + clicked post button
    const goalNeedsPost = /\b(post|publish|share|announce)\b/.test(goalLower);
    if (goalNeedsPost) {
      const hasTypedPost = typedContent.some(t => t.length > 20 && !t.startsWith('http'));
      const clickedPostBtn = clickedOutputs.some(o => /Clicked.*post|Clicked.*publish|Clicked.*share/i.test(o));
      if (!hasTypedPost) {
        this.logger.warn(`Goal check: REJECTED — goal requires posting but no text content was typed`);
        return false;
      }
      if (!clickedPostBtn) {
        this.logger.warn(`Goal check: REJECTED — goal requires posting but Post/Publish button was not clicked`);
        return false;
      }
    }

    // Goal requires typing → must have type action
    const goalNeedsType = /\b(create|write|type|compose)\b/.test(goalLower);
    if (goalNeedsType && typedContent.length === 0) {
      this.logger.warn(`Goal check: REJECTED — goal requires text input but nothing was typed`);
      return false;
    }

    // Goal requires navigation → must have successful navigate
    const goalNeedsNav = /\b(navigate|go to|open|visit)\b/.test(goalLower);
    const navigated = completedSteps.some(s => s.action === 'navigate' && s.output && !s.output.includes('failed'));
    if (goalNeedsNav && !navigated && completedSteps.length > 0) {
      // Not a hard reject — navigation might have been done via other means
    }

    // If ALL hard checks pass, also do a quick LLM verification with the screen
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

    // Include research context if available for better goal verification
    const researchCtx = (sessions.get(sessionId) as any)?._research || '';

    // Include step failure context (reuse failedSteps from pre-checks above)
    const failureCtx = failedSteps.length > 0
      ? `\nFAILED STEPS:\n${failedSteps.map(s => `  Step ${s.index + 1}: "${s.description}" → ${(s.output || '').slice(0, 200)}`).join('\n')}\n`
      : '';

    const prompt =
      `GOAL: ${goal}\n\n` +
      (researchCtx ? `${researchCtx}\n` : '') +
      `COMPLETED STEPS:\n${stepSummary}\n\n` +
      failureCtx +
      extractedData +
      `CURRENT SCREEN TEXT:\n${screenText.slice(0, 2000)}\n\n` +
      `${currentScreen ? 'A screenshot of the current screen is attached.\n\n' : ''}` +
      `Question: Has the goal been ACTUALLY achieved?\n\n` +
      `CRITICAL RULES:\n` +
      `- For ACTION goals (post, create, close, delete, change): verify the ACTION was ACTUALLY performed by checking step outputs.\n` +
      `- Steps that just "navigate" or "read_screen" are NOT evidence of completing the goal.\n` +
      `- If the completed steps show a LOOPING pattern (same actions repeated), the agent was STUCK and the goal was NOT achieved.\n` +
      `- If the goal required typing/posting content but no "type" or "type_text" step succeeded, answer NO.\n` +
      `- DO NOT fabricate or assume success. If you cannot see CONCRETE evidence in the step outputs or screen text that the specific action was done, answer NO.\n` +
      `- Error messages like "This page isn't available" or "Could not find" are FAILURES, not success.\n` +
      `- Look at the CURRENT SCREEN — does it show the result of the goal (e.g., posted content visible, confirmation dialog, settings saved)?\n\n` +
      `Answer EXACTLY one line:\n` +
      `SATISFIED: yes\n` +
      `or\n` +
      `SATISFIED: no | <brief reason>`;

    try {
      const res = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
        user_message: prompt,
        context: {
          system_override:
            `You verify whether a computer-use goal was ACTUALLY achieved. Be skeptical. ` +
            `Error pages ("not available", "not found") are FAILURES, not success. ` +
            `For action goals (close, delete, change), demand evidence of the action completing. ` +
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

    // Include original research if available
    const researchCtx = (session as any)?._research || '';

    const revisionPrompt =
      contextLine +
      `GOAL: ${goal}\n\n` +
      (researchCtx ? `${researchCtx}\nFollow the documented steps above. Do NOT guess — use the research.\n\n` : '') +
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
  private parseStepLines(text: string): Array<{ description: string; action: string; target?: string; anchor?: string }> {
    const steps: Array<{ description: string; action: string; target?: string; anchor?: string }> = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    // Format accepted:
    //   STEP: <action> | <target> | <description>                    (3 fields)
    //   STEP: click_scoped | <target> | <description> | <anchor>     (4 fields)
    // The optional 4th field is used only for click_scoped.
    const toStep = (parts: string[]) => {
      if (parts.length >= 2) {
        const action = parts[0].toLowerCase();
        const step: { description: string; action: string; target?: string; anchor?: string } = {
          action,
          target: parts[1] || undefined,
          description: parts[2] || parts[1] || parts[0],
        };
        if (parts.length >= 4 && parts[3]) {
          step.anchor = parts[3];
        }
        return step;
      }
      if (parts.length === 1) {
        return { action: parts[0].toLowerCase(), description: parts[0] };
      }
      return null;
    };

    for (const line of lines) {
      const stepMatch = line.match(/^(?:STEP\s*\d*\s*:\s*)(.*)/i);
      if (stepMatch) {
        const parts = stepMatch[1].split('|').map(p => p.trim());
        const step = toStep(parts);
        if (step) steps.push(step);
        continue;
      }

      const numberedMatch = line.match(/^\d+\.\s+(.*)/);
      if (numberedMatch) {
        const parts = numberedMatch[1].split('|').map(p => p.trim());
        const step = toStep(parts);
        if (step && parts.length >= 2) steps.push(step);
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
      const screens = await this.runtime.listScreens();
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
   * Validate a proposed (action, target) pair against the plan step's intent
   * and skill-defined constraints. Rejects drift BEFORE it executes.
   *
   * Why this exists: the REACT LLM at each step is given the planned action +
   * current screen and invited to "execute as-is, adapt, or skip". In practice
   * the adaptation latitude lets it drift — clicking post-body text instead of
   * a menu button, clicking Cancel/Discard to "recover" from an earlier
   * failure, swapping a planned `type` into `scroll` because the input isn't
   * visible. Prompt-level guidance ("never click Cancel") doesn't reliably
   * stop this. Controller-level enforcement does.
   *
   * Rules enforced here are derived from concrete observed failures, not
   * speculative — each one corresponds to at least one real CU session that
   * drifted into a bad state because it wasn't blocked.
   *
   * Returns { ok: true } to allow, { ok: false, reason } to reject and re-ask
   * the LLM with the rejection reason in context.
   */
  private validateProposedAction(
    step: PlanStep,
    proposed: { action: string; target: string },
    session: ComputerUseSession,
    matchedSkillIds: string[],
  ): { ok: boolean; reason?: string } {
    const actionLower = (proposed.action || '').toLowerCase();
    const rawTarget = proposed.target || '';
    const targetLower = rawTarget.toLowerCase().trim();
    const targetStripped = targetLower.replace(/^["']+|["']+$/g, '').trim();

    // Rule 1 — Destructive clicks are always blocked.
    // Plans never legitimately request these; when the LLM proposes them it's
    // always an "attempt to recover" from an earlier failure that instead
    // throws away in-progress work (edit drafts, posts, friendships, etc.).
    if (actionLower === 'click' && targetStripped) {
      const DESTRUCTIVE_TARGETS = new Set([
        // English
        'cancel', 'discard', 'discard changes', 'dismiss', 'close', 'exit',
        'delete', 'delete post', 'delete comment', 'remove', 'remove post',
        'turn off', 'hide', 'hide from profile', 'hide from timeline',
        'move to trash', 'report', 'block', 'unfriend', 'unfollow',
        // Vietnamese
        'hủy', 'hủy bỏ', 'bỏ', 'đóng', 'thoát',
        'xóa', 'xóa bài viết', 'xóa bình luận',
        'ẩn', 'ẩn khỏi trang cá nhân', 'ẩn khỏi dòng thời gian',
        'chặn', 'hủy kết bạn', 'bỏ theo dõi',
      ]);
      if (DESTRUCTIVE_TARGETS.has(targetStripped)) {
        return {
          ok: false,
          reason:
            `Destructive click target "${rawTarget}" is hard-blocked (it throws ` +
            `away in-progress work). Plan step was "${step.action}${step.target ? ` → ${step.target}` : ''}". ` +
            `Re-propose an action that advances the plan step. If you cannot, ` +
            `use ACTION: failed with a short reason instead of clicking a ` +
            `destructive control to "escape".`,
        };
      }
    }

    // Rule 2 — Post-body-drift for the FB edit skill.
    // The dominant failure mode we observed: LLM sees the post's prefix text
    // on screen and clicks it, thinking that opens the edit. It doesn't — it
    // navigates to the post permalink, making the menu harder to target.
    if (matchedSkillIds.includes('facebook-edit-post') && actionLower === 'click') {
      const goal = session.goal || '';
      const prefixMatch = goal.match(/["'“]([^"'”]{15,})["'”]/);
      if (prefixMatch) {
        const prefix = prefixMatch[1].toLowerCase().trim();
        // Reject if the click's target contains a substantial chunk (>= 20 chars)
        // of the post-prefix text, OR the click target is contained inside the prefix.
        const probe = prefix.slice(0, 20);
        if (targetLower.includes(probe) || prefix.includes(targetStripped.slice(0, 20))) {
          return {
            ok: false,
            reason:
              `Click target "${rawTarget.slice(0, 60)}" matches the post's own body text. ` +
              `The skill explicitly forbids this — clicking the post text navigates to ` +
              `its permalink and does NOT open the edit menu. Re-propose a click on a ` +
              `specific UI control, e.g. "Actions for this post" (English aria-label of ` +
              `the three-dot menu), "Edit post" (edit option), or "Lưu" / "Save" (save button). ` +
              `If none of those controls are visible, use ACTION: failed instead of clicking ` +
              `post text.`,
          };
        }
      }
    }

    // Rule 3 — Action-type pin: don't silently swap a planned type into scroll.
    // When the plan explicitly says `type` or `click → <named target>`, the
    // LLM swapping to scroll/navigate/etc. almost always means the prior step
    // failed but the LLM is still trying to "make progress" on the plan.
    //
    // EXCEPTION: a click on a known confirmation / context-switch button is
    // allowed. Some sites pop a modal between the composer-open and typing
    // (e.g. Facebook Pages: "You're posting as Steve Tran — Switch to The AI
    // Inc?" with a "Switch Now" button). Without this exception the agent
    // gets stuck because it CAN'T type until the modal is dismissed, and
    // every click attempt is rejected as drift.
    const CONTINUATION_CLICK_TARGETS = [
      'switch now', 'switch', 'continue', 'continue posting', 'ok', 'okay',
      'confirm', 'agree', 'i agree', 'got it', 'done', 'next', 'allow',
      'use this account', 'post as page',
      // Vietnamese
      'chuyển ngay', 'chuyển', 'tiếp tục', 'đồng ý', 'xác nhận', 'cho phép',
    ];
    const isContinuationClick =
      (actionLower === 'click' || actionLower === 'click_scoped') &&
      CONTINUATION_CLICK_TARGETS.some(t => targetStripped === t || targetStripped.startsWith(t + ' '));
    if (
      step.action === 'type' &&
      !['type', 'execute_plan', 'done', 'failed', 'scratch_write'].includes(actionLower) &&
      !isContinuationClick
    ) {
      return {
        ok: false,
        reason:
          `Plan step ${step.index + 1} is a "type" action (target: "${(step.target || '').slice(0, 60)}"). ` +
          `Do not propose "${proposed.action}" instead. Either execute the planned type ` +
          `(ACTION: execute_plan) or stop with ACTION: failed if the text input ` +
          `isn't ready. (If a confirmation/switch dialog is blocking typing, ` +
          `propose a click on its specific button — Switch Now, Continue, OK, ` +
          `Confirm, etc. — which is allowed.)`,
      };
    }
    if (step.action === 'click' && step.target && actionLower === 'scroll') {
      return {
        ok: false,
        reason:
          `Plan step ${step.index + 1} is click → "${step.target}". Do not scroll instead. ` +
          `The target should already be in view from the plan's preceding read/scroll steps. ` +
          `If it isn't, the prior steps failed — use ACTION: failed rather than drifting.`,
      };
    }

    // click_scoped is a legitimate "smarter click" — when the plan step is a
    // plain click, the LLM may upgrade to click_scoped if it supplies an anchor
    // (typically the goal's quoted post prefix). Don't block that swap.
    if (step.action === 'click' && actionLower === 'click_scoped') {
      return { ok: true };
    }

    // Rule 4a — Plan is navigate → URL. The LLM occasionally substitutes
    // `scroll` (presumably thinking the page is already loaded), but if the
    // current page is a different domain, scrolling does nothing useful and
    // the agent then operates on the WRONG page state. Force the navigate.
    if (
      step.action === 'navigate' &&
      step.target &&
      /^https?:\/\//.test(step.target) &&
      (actionLower === 'scroll' || actionLower === 'wait')
    ) {
      return {
        ok: false,
        reason:
          `Plan step ${step.index + 1} is navigate → ${step.target.slice(0, 80)}. ` +
          `Refusing "${proposed.action}" — that doesn't load a new page, and the ` +
          `current tab may not be the destination. Use ACTION: execute_plan to ` +
          `perform the planned navigate, or ACTION: switch_tab if you can confirm ` +
          `the destination tab is already open.`,
      };
    }

    // Rule 4 — Reject switch_tab when the plan says navigate to a URL,
    // unless the switch_tab target unambiguously refers to that URL's domain.
    // Why: the LLM repeatedly substitutes navigate→switch_tab with bare tab
    // labels ("Facebook", "GitHub") that don't match the planned URL — sending
    // the agent to the wrong tab. Substring-matching against tab titles is
    // unreliable for this purpose. Force the planned URL navigation instead.
    if (
      step.action === 'navigate' &&
      step.target &&
      /^https?:\/\//.test(step.target) &&
      actionLower === 'switch_tab'
    ) {
      try {
        const plannedHost = new URL(step.target).hostname.toLowerCase();
        const plannedHostKey = plannedHost.replace(/^www\./, '').split('.')[0]; // 'github', 'facebook'
        const tgtL = targetStripped.toLowerCase();
        const matchesPlanned =
          tgtL.includes(plannedHost) ||
          tgtL.includes(plannedHostKey) ||
          tgtL.includes(step.target.toLowerCase());
        if (!matchesPlanned) {
          return {
            ok: false,
            reason:
              `Plan step ${step.index + 1} is navigate → ${step.target.slice(0, 80)}. ` +
              `Refusing switch_tab → "${rawTarget.slice(0, 60)}" because the target does ` +
              `not unambiguously refer to that URL (host: "${plannedHost}"). switch_tab does ` +
              `loose substring matching against tab titles, which lands on the wrong tab when ` +
              `the query is short or generic. Use ACTION: execute_plan to perform the planned ` +
              `navigate, or ACTION: switch_tab with a query containing the host name ` +
              `"${plannedHostKey}" to be unambiguous.`,
          };
        }
      } catch { /* not a parseable URL — fall through */ }
    }

    return { ok: true };
  }

  /**
   * Resolve the best-guess native app name to target for keyboard routing.
   *
   * Used by key_press / type's AppleScript fallback to set the `app:` parameter
   * so keystrokes reach the right process. Order of precedence:
   *   1. _native_app_mode  — set by open_app for native-app flows
   *   2. share_info.label  — the browser/app label from screen-share (frontend)
   *   3. capture_target    — explicit app/window capture target
   *   4. _browser_app      — default 'Google Chrome' when Chrome Bridge is active
   *                          (set at session create if nothing else is known)
   *
   * Returns null only when the session has no app context at all (e.g.,
   * a screen-mode fullscreen CU session).
   *
   * ASYNC form: if nothing is set but Chrome Bridge IS currently connected
   * (lazily checked against dev-agent), default to 'Google Chrome' and cache
   * on the session. Synchronous callers can fall back to resolveTargetApp().
   */
  private async resolveTargetAppAsync(sessionId: string): Promise<string | null> {
    const sync = this.resolveTargetApp(sessionId);
    if (sync) return sync;
    const session = sessions.get(sessionId);
    if (!session) return null;
    try {
      const health = await this.runtime.health();
      if (health.platform === 'unknown') return null;
      // Check if Chrome Bridge is connected
      const screens = await this.runtime.listScreens();
      if (screens.length > 0) {
        (session as any)._browser_app = 'Google Chrome';
        this.logger.log(`resolveTargetAppAsync(${sessionId}): runtime healthy → caching _browser_app="Google Chrome"`);
        return 'Google Chrome';
      }
    } catch { /* runtime unreachable */ }
    return null;
  }

  private resolveTargetApp(sessionId: string): string | null {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const nativeApp = (session as any)?._native_app_mode;
    if (nativeApp) return nativeApp;
    const shareInfo = (session as any)?._share_info as { displaySurface?: string; label?: string } | undefined;
    if (shareInfo?.displaySurface && shareInfo.displaySurface !== 'monitor' && shareInfo.label) {
      const fromLabel = getAppNameFromLabel(shareInfo.label);
      if (fromLabel) return fromLabel;
    }
    const captureTarget = (session as any)?._capture_target as { mode?: string; target?: string } | undefined;
    if (captureTarget?.target && (captureTarget.mode === 'window' || captureTarget.mode === 'app')) {
      return captureTarget.target;
    }
    return (session as any)?._browser_app || null;
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
    } else {
      appName = (session as any)?._browser_app || null;
    }

    if (isFullScreen) {
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

    try {
      await this.runtime.focusWindow(appName);
    } catch (err: any) {
      this.logger.warn(`Failed to focus "${appName}": ${err.message}`);
    }

    try {
      const bounds = await this.runtime.getWindowBounds(appName);
      if (bounds) {
        this.logger.log(`Window bounds: ${JSON.stringify(bounds)}`);
        return bounds;
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

    // 1. Primary: native screenshot via runtime
    try {
      // If targeting a specific window/app, focus it first.
      const captureTarget = (session as any)?._capture_target as { mode: string; target?: string } | undefined;
      const focusTarget =
        (captureTarget?.target && (captureTarget.mode === 'window' || captureTarget.mode === 'app'))
          ? captureTarget.target
          : ((session as any)?._native_app_mode || null);
      if (focusTarget) {
        await this.runtime.focusWindow(focusTarget);
        await new Promise(r => setTimeout(r, 300));
      }

      const screenRegion = this.getScreenRegion(sessionId);
      const lastAction = session?.plan?.[session.current_step]?.action?.toLowerCase() || '';
      const isNativeAction = ['open_app', 'click_screen', 'key_press'].includes(lastAction);

      const screenshot = await this.runtime.getScreenImage({
        region: screenRegion && !isNativeAction ? screenRegion : undefined,
        scale: 2,
      });

      if (screenshot) {
        this.logger.log(
          `Native screenshot captured (${screenshot.length} chars, target: ${captureTarget?.mode || 'full_screen'}${screenRegion ? ` screen@${screenRegion.x},${screenRegion.y}` : ''})`,
        );
        return screenshot;
      }
      this.logger.warn(`Native screenshot appears blank — Screen Recording permission may not be granted to OasisScreenCapture.app`);
    } catch { /* native capture not available — fall through */ }

    // 2. Fallback: browser screen-share frame
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

      const screenRegion = (session as any)?._screen_region as { width: number; height: number } | undefined;
      if (screenRegion?.width && screenRegion.width > 0) {
        nativeWidth = screenRegion.width;
        this.logger.log(`Using screen_region.width=${nativeWidth} for coordinate scaling`);
      }

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
        const size = await this.runtime.getScreenSize();
        nativeWidth = size.width;
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

    // read_screen: extract text from page via Chrome Bridge (reliable), fall back to OCR
    if (action === 'read_screen' || action === 'read_page' || action === 'extract_text') {
      const img = await this.getScreenImage(sid);

      // Transient redirect/auth patterns — if the URL matches, wait and retry
      const TRANSIENT_URL_PATTERNS = [
        /\/two_step_verification\//i,
        /\/checkpoint\//i,
        /\/login\/.*redirect/i,
        /\/auth\/.*callback/i,
        /\/oauth\//i,
        /\/sso\//i,
        /accounts\.google\.com\/.*continue=/i,
      ];

      // Step 1: Get Chrome URL/title context (fast, always works)
      const session3 = sessions.get(sid);
      const workUrlHint = (sessions.get(sid) as any)?._current_tab_hint || '';
      let chromeContext = '';
      let retries = 0;
      const MAX_TRANSIENT_RETRIES = 3;

      const fetchPageText = async (): Promise<{ raw: string; pageContent: string; url: string } | null> => {
        try {
          const pageResult = await this.runtime.getPageText({ tabHint: workUrlHint });
          if (pageResult.text) {
            const raw = `URL: ${pageResult.url || ''}\nTitle: ${pageResult.title || ''}\n\nPage content:\n${pageResult.text}`;
            return { raw, pageContent: pageResult.text, url: pageResult.url || '' };
          }
        } catch (err: any) {
          this.logger.warn(`get_page_text failed: ${err.message}`);
        }
        return null;
      };

      let result = await fetchPageText();

      // Retry if page is on a transient auth/redirect URL
      while (result && retries < MAX_TRANSIENT_RETRIES) {
        const isTransient = TRANSIENT_URL_PATTERNS.some(p => p.test(result!.url));
        if (!isTransient) break;
        retries++;
        this.logger.log(`read_screen: transient URL detected (${result.url.slice(0, 80)}), waiting 3s and retrying (${retries}/${MAX_TRANSIENT_RETRIES})`);
        await new Promise(r => setTimeout(r, 3000));
        result = await fetchPageText();
      }

      if (result) {
        if (result.pageContent.length > 50) {
          this.logger.log(`read_screen via get_page_text+JS: ${result.raw.length} chars (content: ${result.pageContent.length} chars)${retries > 0 ? ` after ${retries} retries` : ''}`);
          return { output: result.raw, screenshot: img };
        }
        // JS extraction didn't work — keep URL/title for context
        chromeContext = result.raw.split('\n\nPage content:')[0];
        this.logger.log(`read_screen: got Chrome URL/title (${chromeContext.length} chars) but no JS content`);
      }

      // Step 2: Native macOS Vision OCR via runtime
      try {
        const screenRegion = this.getScreenRegion(sid);
        const ocrResult = await this.runtime.ocrScreenshot({
          region: screenRegion || undefined,
        });
        if (ocrResult.text && ocrResult.text.length > 50) {
          const fullOutput = chromeContext ? `${chromeContext}\n\nVisible text (OCR):\n${ocrResult.text}` : ocrResult.text;
          this.logger.log(`read_screen via native OCR: ${ocrResult.text.length} chars`);
          return { output: fullOutput, screenshot: img };
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
        // Strip quotes and whitespace the LLM sometimes wraps around URLs
        const cleanTarget = target.replace(/^["'\s]+|["'\s]+$/g, '').trim();

        // Validate: reject targets that are clearly not URLs (LLM sometimes outputs
        // instructions like "navigate to the settings page" instead of an actual URL)
        const looksLikeUrl = /^https?:\/\//.test(cleanTarget) ||
          /^[\w][\w.-]*\.\w{2,}(\/|$)/.test(cleanTarget); // e.g. facebook.com, notebooklm.google.com/path
        if (!looksLikeUrl) {
          this.logger.warn(`Navigate: rejecting non-URL target: "${cleanTarget.slice(0, 80)}"`);
          return {
            output: `Cannot navigate to "${cleanTarget.slice(0, 60)}" — this is not a valid URL. Use a full URL like https://example.com`,
            screenshot: await this.getScreenImage(sid),
          };
        }

        const url = cleanTarget.startsWith('http') ? cleanTarget : `https://${cleanTarget}`;
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
            try { (session2 as any)._current_tab_hint = new URL(url).hostname; } catch { /* ignore */ }
            // Navigate implies we're now in browser mode — clear any stale
            // native_app_mode flag set by an earlier open_app action. Otherwise
            // the adaptive loop keeps describing screenshots via VL instead of
            // reading the actual page DOM via Chrome Bridge.
            if ((session2 as any)._native_app_mode) {
              this.logger.log(`Navigate: clearing _native_app_mode (was "${(session2 as any)._native_app_mode}") — switching to browser mode`);
              (session2 as any)._native_app_mode = null;
            }
          }

          // Ensure Chrome window is on the primary screen (multi-monitor fix).
          // The agent only screenshots the primary screen, so Chrome must be there.
          try {
            const boundsRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'get_window_bounds', text: 'Google Chrome',
            }, { timeout: 5000 });
            const bounds = boundsRes.data?.bounds;
            if (bounds && screenRegion && bounds.x >= screenRegion.x + screenRegion.width) {
              this.logger.log(`Chrome window on secondary screen (x=${bounds.x}) — moving to primary`);
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'move_window_to_screen',
                text: 'Google Chrome', x: screenRegion.x, y: screenRegion.y + 25,
              }, { timeout: 5000 });
              await new Promise(r => setTimeout(r, 500));
            }
          } catch { /* best effort */ }
        } else {
          // Subsequent navigates: check if the URL domain differs from the current page.
          // If different domain → open NEW TAB (keeps both pages accessible via switch_tab).
          // If same domain → reuse existing tab.
          const currentHint = (session2 as any)?._work_url_hint || '';
          let newDomain = true;
          try {
            const urlHost = new URL(url).hostname;
            newDomain = !currentHint || !urlHost.includes(currentHint.split('/')[0]);
          } catch { /* assume new domain */ }

          try {
            await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action',
              action: 'chrome_set_url',
              text: url,
              url_hint: newDomain ? undefined : currentHint,
              new_tab: newDomain, // Open new tab for different domains
            }, { timeout: 15000 });
            this.logger.log(`Navigate: ${newDomain ? 'new tab' : 'same tab'} → ${url}`);
            // Update _current_tab_hint so subsequent reads/clicks target the
            // tab we just navigated to. Was previously only updated on the
            // first navigate, leaving the hint stale across subsequent
            // navigates and making get_page_text read the WRONG tab.
            if (session2) {
              try {
                (session2 as any)._current_tab_hint = new URL(url).hostname;
              } catch { /* ignore */ }
            }
          } catch (err: any) {
            this.logger.warn(`Chrome Bridge navigate failed: ${err.message}`);
            // Fallback: AppleScript direct navigation
            try {
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'focus_window', text: 'Google Chrome',
              }, { timeout: 5000 });
              await new Promise(r => setTimeout(r, 200));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'hotkey', keys: [hostModifier(), 'l'],
              }, { timeout: ACTION_TIMEOUT_MS });
              await new Promise(r => setTimeout(r, 300));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'type_text', text: url,
              }, { timeout: ACTION_TIMEOUT_MS });
              await new Promise(r => setTimeout(r, 200));
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'key_press', key: 'enter',
              }, { timeout: ACTION_TIMEOUT_MS });
            } catch { /* best effort */ }
          }

          // Update work URL hint — use path portion for more specific matching
          if (session2) {
            try {
              const parsed = new URL(url);
              (session2 as any)._current_tab_hint = parsed.hostname + parsed.pathname;
            } catch { /* ignore */ }
          }
        }

        await new Promise(r => setTimeout(r, 2500));
        const navScreen = await this.getScreenImage(sid);

        // Read page text after navigation to give the LLM actual content
        let navOutput = `Navigated to ${url}`;
        try {
          const pageRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action',
            action: 'get_page_text',
            text: session2 ? (session2 as any)._current_tab_hint || '' : '',
          }, { timeout: 10000 });
          if (pageRes.data?.success && pageRes.data.output) {
            const pageTitle = (pageRes.data.output as string).match(/^Title:\s*(.+)$/m)?.[1]?.trim();
            navOutput = pageTitle ? `${pageTitle}` : navOutput;
          }
        } catch { /* ignore */ }

        return { output: navOutput, screenshot: navScreen };
      }

      case 'click_scoped': {
        // Anchor-and-traverse click. Plan step supplies:
        //   step.anchor  — unique text prefix identifying the container (e.g. a
        //                  post's first 30–60 chars). REQUIRED.
        //   step.target  — the target's aria-label or inner text (e.g.
        //                  "Actions for this post", "Edit post", "Lưu").
        //                  REQUIRED.
        // Matches both as ARIA-LABEL first, then as inner text. Clicks via CDP
        // (trusted event) with a DOM-event fallback if CDP is unavailable.
        let anchorText = (step as any)?.anchor || '';
        let scopedTarget = target || '';

        // Swap-correction heuristic. The planner sometimes emits the fields in
        // reverse order (anchor-like text in the target slot, aria-label in the
        // anchor slot). Detect and correct this BEFORE hitting Chrome Bridge.
        //
        // Signals that indicate a swap:
        //   - target is long (>= 60 chars) AND anchor is short (<= 40 chars)
        //   - target contains >= 20 chars of the goal's quoted prefix
        //     AND anchor looks like a short aria-label
        const goal = (sessions.get(sid)?.goal || '');
        const prefixMatch = goal.match(/["'“]([^"'”]{15,})["'”]/);
        const goalPrefix = prefixMatch ? prefixMatch[1].toLowerCase() : '';
        const targetLower = scopedTarget.toLowerCase();
        const anchorLower = anchorText.toLowerCase();
        const KNOWN_SHORT_LABELS = [
          'actions for this post', 'more options for this post', 'edit post',
          'save', 'lưu', 'post', "what's on your mind",
          'tùy chọn khác cho bài viết này', 'chỉnh sửa bài viết',
        ];
        const anchorLooksLikeLabel = KNOWN_SHORT_LABELS.some(l => anchorLower.includes(l));
        const targetLooksLikeAnchor =
          (goalPrefix && targetLower.includes(goalPrefix.slice(0, 20))) ||
          (scopedTarget.length >= 60 && anchorText.length <= 40);
        if (anchorLooksLikeLabel && targetLooksLikeAnchor) {
          this.logger.warn(
            `click_scoped: detected swapped anchor/target — correcting ` +
            `(was anchor="${anchorText.slice(0, 40)}" target="${scopedTarget.slice(0, 40)}")`,
          );
          const tmp = anchorText;
          anchorText = scopedTarget;
          scopedTarget = tmp;
          // Also persist the correction back onto the step so subsequent
          // retries use the fixed values.
          (step as any).anchor = anchorText;
          step.target = scopedTarget;
        }

        if (!anchorText) {
          return { output: 'click_scoped requires step.anchor (post/container prefix text)' };
        }
        if (!scopedTarget) {
          return { output: 'click_scoped requires target (aria-label or text of the control to click)' };
        }
        try {
          const scopedRes = await axios.post(
            `${DEV_AGENT_URL}/internal/dev-agent/execute`,
            {
              tool: 'computer_action',
              action: 'click_scoped',
              anchor_text: anchorText,
              target_aria_label: scopedTarget,
            },
            { timeout: ACTION_TIMEOUT_MS },
          );
          const data = scopedRes.data || {};
          const output = data.output || (data.success ? `click_scoped: anchor="${anchorText.slice(0, 40)}", target="${scopedTarget}"` : 'click_scoped failed');
          await new Promise(r => setTimeout(r, 350));
          const scopedScreen = await this.getScreenImage(sid);
          if (!data.success) {
            // Return as non-throwing failure — REACT loop will see the output
            // text and can decide to retry, adapt, or give up. The drift guard
            // prevents it from escaping into a destructive fallback.
            this.logger.warn(`click_scoped failed: ${output}`);
          }
          return { output, screenshot: scopedScreen };
        } catch (err: any) {
          this.logger.warn(`click_scoped exception: ${err.message}`);
          return { output: `click_scoped error: ${err.message}` };
        }
      }

      case 'find_ui_element':
      case 'click': {
        // Pre-publish guard: refuse to click "close / cancel / discard / exit"
        // if the agent has just typed substantial draft content that hasn't
        // been committed via a post/publish/submit click yet. This prevents
        // the classic failure where the agent composes a full Facebook post
        // in Vietnamese and then clicks "close" on the composer modal,
        // discarding all the work.
        // Strip surrounding quotes — the LLM commonly wraps text targets in
        // quotes ("What's on your mind") which prevents substring matches in
        // both Chrome Bridge and OCR. Mirror navigate/switch_tab cleanup.
        const cleanClickTarget = (target || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
        const ctLower = cleanClickTarget.toLowerCase();
        const isDiscardAction =
          /^(close|cancel|discard|dismiss|exit|back|×|x)$/i.test(ctLower) ||
          /^(close|cancel|discard|dismiss)\s/i.test(ctLower) ||
          /discard.*draft|close.*without.*saving|cancel.*post|leave.*page|exit.*editor/i.test(ctLower);

        if (isDiscardAction) {
          const guardSession = sessions.get(sid);
          const recentSteps = (guardSession?.plan || []).slice(-10);
          // Find the most recent completed `type` action whose output starts
          // with "Typed:". We used to exclude URL-only drafts, but that left
          // a loophole: when the agent types a source URL into a modal
          // (NotebookLM Add Source, Twitter link-share, etc.) and then clicks
          // Close instead of Insert/Submit, the URL is lost. The URL IS the
          // valuable input in those contexts — block the discard.
          let draftType: typeof recentSteps[0] | null = null;
          for (let i = recentSteps.length - 1; i >= 0; i--) {
            const st = recentSteps[i];
            if (st.status !== 'completed' || st.action !== 'type' || !st.output) continue;
            const o = st.output.trim();
            if (o.startsWith('Skipped:')) continue;
            const payload = o.replace(/^Typed:\s*/i, '').trim();
            // Require some minimum length so single-char typos don't block close.
            if (payload.length < 10) continue;
            draftType = st;
            break;
          }
          if (draftType) {
            // Is there a later submit/publish click BETWEEN the draft-type and now?
            // Broadened vocabulary: include Insert, Add, OK, Done, Save — the
            // typical modal-submit verbs — so closing AFTER a proper submit is fine.
            const draftIdx = recentSteps.indexOf(draftType);
            const publishAfter = recentSteps.slice(draftIdx + 1).some(s =>
              s.status === 'completed' && s.action === 'click' &&
              /\b(post|publish|share|send|submit|tweet|insert|^add\b|ok|done|save|confirm|apply)\b/i.test(s.target || ''),
            );
            if (!publishAfter) {
              const preview = (draftType.output || '').replace(/^Typed:\s*/i, '').slice(0, 100);
              this.logger.warn(`click: REFUSED discard "${cleanClickTarget}" — draft content still uncommitted (${preview.length} chars): "${preview}..."`);
              return {
                output:
                  `⚠️ REFUSED to click "${cleanClickTarget}" — this would discard your uncommitted input. ` +
                  `You typed "${preview.slice(0, 80)}..." in a previous step but have NOT clicked a submit button yet. ` +
                  `Click the RIGHT submit for this context: "Insert" / "Add" / "Submit" in a source dialog, ` +
                  `"Post" / "Publish" / "Share" in a composer, "Save" / "Done" in a settings dialog. ` +
                  `If you genuinely want to throw the input away, first record your reasoning in scratch_write, then retry this click.`,
              };
            }
          }
        }

        // ── CUA unified click: Chrome Bridge DOM → ui_parser OCR/GroundingDINO → pixel fallback ──
        const nativeAppName = (sessions.get(sid) as any)?._native_app_name;

        // Ensure we're on the right Chrome tab before clicking.
        // The Chrome Bridge only searches the active tab, so switching first
        // prevents "element not found" when the element is on a different tab.
        if (!nativeAppName) {
          const urlHint = (sessions.get(sid) as any)?._current_tab_hint;
          if (urlHint) {
            try {
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action',
                action: 'switch_tab',
                text: urlHint,
              }, { timeout: 5000 });
            } catch { /* best effort */ }
          }
        }

        // 1. Chrome Bridge DOM click first — fast, deterministic, trusted
        // events. The previous implementation skipped this entirely and went
        // straight to OCR/pixel clicks, which can't reliably find DOM
        // controls like Facebook's "What's on your mind?" composer trigger
        // (the visible text differs from the trigger element by enough that
        // OCR coordinates land outside the click target).
        if (action === 'click' && !nativeAppName && cleanClickTarget) {
          try {
            const cbRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action',
              action: 'chrome_bridge_click',
              text: cleanClickTarget,
            }, { timeout: 10000 });
            if (cbRes.data?.success) {
              this.logger.log(`click via Chrome Bridge: "${cleanClickTarget.slice(0, 60)}"`);
              await new Promise(r => setTimeout(r, 800));
              let postOut = '';
              try {
                // Read the page-text of whichever tab is now active. We
                // intentionally pass NO url_hint here: the click landed on the
                // currently-active tab, so the post-click state lives on that
                // same tab. Using `_current_tab_hint` here was wrong — that
                // hint goes stale across switch_tab/back navigations and made
                // the agent read a different tab than the one it had just
                // clicked, then misdiagnose the page state.
                const pageRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                  tool: 'computer_action',
                  action: 'get_page_text',
                  text: '',
                }, { timeout: 10000 });
                if (pageRes.data?.success) {
                  postOut = pageRes.data.output;
                  // Refresh _current_tab_hint to the URL we actually landed on,
                  // so subsequent steps don't carry the stale hint forward.
                  const urlMatch = (pageRes.data.output as string).match(/^URL:\s*(.+)$/m);
                  if (urlMatch) {
                    try {
                      const parsed = new URL(urlMatch[1].trim());
                      const s = sessions.get(sid);
                      if (s) (s as any)._current_tab_hint = parsed.hostname + parsed.pathname;
                    } catch { /* ignore */ }
                  }
                }
              } catch { /* ignore */ }
              const postScreen = await this.getScreenImage(sid);
              // ALWAYS prefix the output with "Clicked '<target>' via Chrome Bridge"
              // — checkGoalSatisfaction's hard-check pattern looks for that
              // exact prefix to confirm a Post/Publish/Share button was hit.
              // Returning bare page text (postOut) silently caused the goal
              // to be rejected as "no Post button was clicked" even when the
              // post had actually published.
              const clickedHeader = `Clicked "${cleanClickTarget}" via Chrome Bridge`;
              const combinedOut = postOut ? `${clickedHeader}\n\n${postOut}` : (cbRes.data.output ? `${clickedHeader} — ${cbRes.data.output}` : clickedHeader);
              return {
                output: combinedOut,
                screenshot: postScreen,
              };
            }
            // Chrome Bridge responded but couldn't click — log and fall through to pixel.
            const reason = cbRes.data?.output || cbRes.data?.error || 'no success flag';
            this.logger.warn(`click: Chrome Bridge declined "${cleanClickTarget.slice(0, 60)}" → falling back to pixel: ${String(reason).slice(0, 120)}`);
          } catch (e: any) {
            this.logger.warn(`click: Chrome Bridge threw for "${cleanClickTarget.slice(0, 60)}" → falling back to pixel: ${(e.message || '').slice(0, 120)}`);
          }
        }

        const cuaRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
          tool: 'computer_action',
          action: action === 'find_ui_element' ? 'find_ui_element' : 'click_ui_element',
          text: target,
          ...(nativeAppName ? { app: nativeAppName } : {}),
        }, { timeout: 12000 });

        if (cuaRes.data?.success) {
          this.logger.log(`CUA ${action}: "${target}" → ${cuaRes.data.output}`);
          if (action === 'click') {
            await new Promise(r => setTimeout(r, 800));
            // Read page text after click — pass NO url_hint so we read the
            // active tab (where the click actually landed). Using
            // `_current_tab_hint` here was wrong because it can be stale
            // across switch_tab/back navigations and made the agent
            // misdiagnose which page it was on after a click.
            let postClickOutput = '';
            try {
              const pageRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action',
                action: 'get_page_text',
                text: '',
              }, { timeout: 10000 });
              if (pageRes.data?.success) {
                postClickOutput = pageRes.data.output;
                const urlMatch = (pageRes.data.output as string).match(/^URL:\s*(.+)$/m);
                if (urlMatch) {
                  try {
                    const parsed = new URL(urlMatch[1].trim());
                    const s = sessions.get(sid);
                    if (s) {
                      (s as any)._work_url_hint = parsed.hostname + parsed.pathname;
                      (s as any)._current_tab_hint = parsed.hostname + parsed.pathname;
                    }
                  } catch { /* ignore */ }
                }
              }
            } catch { /* ignore */ }
            const postClickScreen = await this.getScreenImage(sid);
            return {
              output: postClickOutput || cuaRes.data.output,
              screenshot: postClickScreen,
            };
          }
          // find_ui_element — just return the result
          return { output: cuaRes.data.output, screenshot: cuaRes.data?.screenshot };
        }

        // CUA failed — return the error
        this.logger.warn(`CUA ${action} failed: ${cuaRes.data?.output}`);
        const fallbackScreen = await this.getScreenImage(sid);
        return {
          output: cuaRes.data?.output || `Could not ${action} "${target}" on screen`,
          screenshot: fallbackScreen,
        };
      }

      case 'type': {
        if (!target) return { output: 'type action requires target text' };

        // Strip LLM format artifacts — sometimes the LLM puts the action format in the target:
        // e.g., 'type | TARGET = "actual text"' → 'actual text'
        let typeTarget = target;
        if (typeTarget.match(/^(type|click|navigate)\s*\|\s*TARGET\s*=\s*/i)) {
          typeTarget = typeTarget.replace(/^(type|click|navigate)\s*\|\s*TARGET\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim();
          this.logger.log(`type: stripped LLM format from target → "${typeTarget.slice(0, 50)}"`);
        }
        if (!typeTarget) return { output: 'type action requires target text (empty after cleanup)' };

        // Skip duplicate typing ONLY when the IMMEDIATELY PREVIOUS type was
        // byte-for-byte identical. This prevents double-submitting the same
        // URL/text when the adaptive loop accidentally replays the last step.
        //
        // Previously this used fuzzy prefix matching, which caused a serious
        // failure mode: a plan step asked to type a Vietnamese post, the LLM
        // temporarily reused the YouTube URL as target, and the fuzzy match
        // with step 4's URL typing silently returned "Skipped" without
        // actually typing anything — modal stayed empty, downstream Insert
        // clicks had nothing to submit, goal failed. Exact match only.
        const prevTypeSteps = (sessionId ? sessions.get(sessionId) : undefined)?.plan
          ?.filter(s => s.status === 'completed' && s.action === 'type' && s.output) || [];
        if (prevTypeSteps.length > 0) {
          const lastTyped = prevTypeSteps[prevTypeSteps.length - 1].output?.replace(/^Typed:\s*/i, '').trim() || '';
          if (lastTyped && lastTyped === typeTarget.trim()) {
            this.logger.log(`type: SKIPPING exact duplicate of immediately previous type (both: ${typeTarget.slice(0, 60)}...)`);
            return { output: `Skipped: identical content already typed in the immediately previous step` };
          }
        }

        // If the type target looks like a composition request (post, message, email)
        // rather than a literal string (URL, search query, short command), compose
        // proper content using the LLM with data collected from previous steps.
        const typeSessCtx = sessionId ? sessions.get(sessionId) : undefined;
        const goalLower = (typeSessCtx?.goal || '').toLowerCase();
        const descLower = (step.description || '').toLowerCase();
        // Compose content when the goal/step involves creating posts, messages, or content
        // that should reference collected data. Skip for simple inputs (URLs, search queries).
        const isComposition = (
          descLower.match(/compose|post|write|draft|content|vietnamese|message/) ||
          goalLower.match(/compose.*post|write.*post|post.*on.*facebook|post.*on.*homepage|vietnamese/)
        ) && !typeTarget.match(/^https?:\/\//) // Don't compose URLs
          && !descLower.match(/search|url|navigate/); // Don't compose search queries

        let textToType = typeTarget;
        if (isComposition && typeSessCtx) {
          try {
            // Collect data from previous read_screen steps
            const collectedData = typeSessCtx.plan
              .filter(s => s.status === 'completed' && s.output && ['read_screen', 'read_page', 'navigate'].includes(s.action || ''))
              .map(s => s.output!)
              .join('\n---\n')
              .slice(0, 3000);

            // Surface what was already typed in earlier type steps. Without
            // this the LLM composes the same English paragraph twice for a
            // bilingual "English then Vietnamese" plan, since each compose
            // call sees the same goal/data and has no idea this is the
            // SECOND typing — both pass produce the higher-priority English.
            const priorTyped = (typeSessCtx.plan
              .filter(s => s.status === 'completed' && s.action === 'type' && s.output)
              .map(s => (s.output || '').replace(/^Typed:\s*/i, '').trim())
              .filter(Boolean)
            ) as string[];
            const priorBlock = priorTyped.length
              ? `ALREADY-TYPED (do NOT repeat or paraphrase any of this — your output must continue the post, not restart it):\n${priorTyped.map((t, i) => `[#${i + 1}] ${t.slice(0, 600)}`).join('\n\n')}\n\n`
              : '';

            // Detect a language hint in the step description so we can
            // explicitly direct the LLM. The plan often has steps like
            // "Type English paragraph" / "Type Vietnamese paragraph" — we
            // route the composition accordingly.
            const desc = (step.description || '').toLowerCase();
            const stepLangHint = (() => {
              if (/\bvietnamese\b|tiếng việt|\btv\b/.test(desc)) return 'Vietnamese';
              if (/\benglish\b|tiếng anh/.test(desc)) return 'English';
              return null;
            })();
            const langDirective = stepLangHint
              ? `- THIS STEP MUST BE IN ${stepLangHint.toUpperCase()}. The plan splits content by language; this is the ${stepLangHint} portion. Output ONLY ${stepLangHint} text — no other language, no translation, no labels.\n`
              : `- If the goal mentions a specific language (Vietnamese, etc.), write in that language\n`;

            const composeRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
              user_message:
                `GOAL: ${typeSessCtx.goal}\n\n` +
                `DATA COLLECTED FROM PREVIOUS STEPS:\n${collectedData}\n\n` +
                priorBlock +
                `CURRENT TASK: Compose the text content to type.\n` +
                `The user wants to type this on: ${step.description || 'a text field'}\n\n` +
                `RULES:\n` +
                `- Write ONE single, concise paragraph for THIS step — DO NOT restate the same idea twice.\n` +
                `  Past failure: composed two similar paragraphs that got published as one duplicated post.\n` +
                `- Hard length cap: 600 characters for this step. For a social post total aim for 300-500.\n` +
                `- Write the ACTUAL content to type, not instructions about what to type.\n` +
                langDirective +
                `- If posting on social media, write an engaging post referencing the collected data.\n` +
                `- If the goal says "this post was done by CU agent" or similar, include that mention.\n` +
                `- Keep it natural and human-sounding.\n` +
                `- Output ONLY the text to type, nothing else — no quotes, no labels, no explanation,\n` +
                `  no second draft, no "alternatively", no "or you could say".\n`,
              context: {
                system_override:
                  'You compose text content. Output ONE single concise version for THIS step only. Never repeat already-typed content. Never produce two drafts. No quotes, no labels, no markdown.',
                max_tokens: 320,
              },
            }, { timeout: 20000 });

            const composed = (composeRes.data?.response_text || composeRes.data?.response || '').trim();
            if (composed && composed.length > 20) {
              textToType = composed;
              this.logger.log(`type: composed ${textToType.length} chars of content`);
            }
          } catch (err: any) {
            this.logger.debug(`Content composition failed: ${err.message} — using original target`);
          }
        }

        // Before typing, ensure the input field is focused.
        // Strategy:
        //   1. If a native app is open, try Cmd+N (new chat/document) to get a fresh input
        //   2. Then click near the bottom of the screen where input fields typically are
        //   3. Small delay to let focus settle
        const typeSession = sessionId ? sessions.get(sessionId) : undefined;
        const nativeApp = (typeSession as any)?._native_app_mode;

        if (nativeApp) {
          // 1. Re-focus the target app
          await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'focus_window', text: nativeApp,
          }, { timeout: 5000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 500));

          // 2. For non-skill plans only: send Cmd+N to create new chat.
          // Skip if using a skill plan (the skill has a separate key_press step for Cmd+N).
          const isSkillPlan = !!(typeSession as any)?._active_skill_id;
          if (!isSkillPlan) {
            const chatApps = ['chatgpt', 'claude', 'slack', 'discord', 'messages', 'telegram'];
            const isChat = chatApps.some(a => (nativeApp as string).toLowerCase().includes(a));
            if (isChat) {
              try {
                await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                  tool: 'computer_action', action: 'hotkey', keys: 'command,n',
                  app: nativeApp, // Target the specific process
                }, { timeout: 5000 });
                this.logger.log(`type: sent Cmd+N to ${nativeApp} for new chat`);
                await new Promise(r => setTimeout(r, 1000));
              } catch { /* continue */ }
            }
          }

          // 3. Click the input field using OCR — match app-specific placeholders first
          const appLower = (nativeApp as string).toLowerCase();
          let appPlaceholders: string[];
          if (appLower.includes('chatgpt')) {
            appPlaceholders = ['Ask anything', 'Message ChatGPT'];
          } else if (appLower.includes('claude')) {
            appPlaceholders = ['Ask Claude', 'How can Claude help'];
          } else {
            appPlaceholders = ['Type a message', 'Message', 'Type here', 'Send a message'];
          }

          let inputClicked = false;
          for (const placeholder of appPlaceholders) {
            if (inputClicked) break;
            try {
              const clickRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'click_ui_element', text: placeholder,
              }, { timeout: 12000 });
              if (clickRes.data?.success) {
                this.logger.log(`type: clicked input via OCR "${placeholder}" at ${clickRes.data.output?.slice(0, 60)}`);
                inputClicked = true;
              }
            } catch { /* try next */ }
          }
          await new Promise(r => setTimeout(r, 300));
        }

        // Type the text — use Chrome Bridge for browser pages (handles contenteditable),
        // AppleScript keystroke for native apps.
        //
        // Regardless of path, keep the target window frontmost so either
        //   (a) Chrome Bridge types into the active tab, or
        //   (b) AppleScript keystrokes reach the right process
        // when the user (or the OS) pulled focus elsewhere between steps.
        let typeSuccess = false;
        const typeTargetApp = sessionId ? await this.resolveTargetAppAsync(sessionId) : null;
        if (!nativeApp) {
          // Browser mode: ensure Chrome window is frontmost, then try Chrome Bridge
          // type_text (works with contenteditable like Facebook's edit modal).
          if (typeTargetApp) {
            try {
              await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'focus_window', text: typeTargetApp,
              }, { timeout: 3000 });
              await new Promise(r => setTimeout(r, 150));
            } catch { /* best-effort — continue even if focus failed */ }
          }
          let bridgeRefusalReason: string | null = null;
          try {
            const bridgeRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'chrome_bridge_type', text: textToType,
            }, { timeout: 15000 });
            if (bridgeRes.data?.success) {
              this.logger.log(`type: Chrome Bridge typed ${textToType.length} chars`);
              typeSuccess = true;
            } else {
              const reason = bridgeRes.data?.output || bridgeRes.data?.error || 'no success flag';
              bridgeRefusalReason = String(reason).slice(0, 240);
              this.logger.warn(`type: Chrome Bridge declined (${textToType.length} chars): ${bridgeRefusalReason}`);
            }
          } catch (e: any) {
            bridgeRefusalReason = (e.message || 'request failed').slice(0, 240);
            this.logger.warn(`type: Chrome Bridge threw: ${bridgeRefusalReason}`);
          }

          // In browser context, an AppleScript keystroke fallback is useless
          // when there is no focused editable — it just dumps keystrokes
          // into the void (or worse, into a search box / nav bar / shortcut
          // handler). Throw so the adaptive loop marks the step FAILED and
          // the LLM gets a chance to re-open the composer / click the input
          // field, instead of marching on to click "Post" against a blank
          // composer.
          if (!typeSuccess && bridgeRefusalReason) {
            throw new Error(
              `type intent failed: ${bridgeRefusalReason} ` +
              `— no editable target found; the composer/modal probably isn't ` +
              `open or focused. Click the composer trigger first, then retry type.`,
            );
          }
        }
        if (!typeSuccess) {
          // Native app or Chrome Bridge fallback: AppleScript keystroke.
          // Pass the resolved app so keystrokes don't leak to whatever is
          // frontmost if the user switched windows mid-session.
          const appForKeystroke = nativeApp || typeTargetApp;
          await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`,
            {
              tool: 'computer_action', action: 'type_text', text: textToType,
              ...(appForKeystroke ? { app: appForKeystroke } : {}),
            },
            { timeout: ACTION_TIMEOUT_MS });
          if (appForKeystroke) {
            this.logger.log(`type: AppleScript fallback → "${appForKeystroke}" (${textToType.length} chars)`);
          }
        }
        await new Promise(r => setTimeout(r, 300));

        // Press Enter to send (for chat apps only — NOT for social media posts)
        const typeSess = sessionId ? sessions.get(sessionId) : undefined;
        const nApp = (typeSess as any)?._native_app_mode;
        if (nApp) {
          const chatApps2 = ['chatgpt', 'claude', 'slack', 'discord', 'messages'];
          if (chatApps2.some(a => (nApp as string).toLowerCase().includes(a))) {
            await new Promise(r => setTimeout(r, 500));
            await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'key_press', key: 'enter',
              app: nApp,
            }, { timeout: 5000 }).catch(() => {});
            this.logger.log(`type: auto-pressed Enter to send in ${nApp}`);
            await new Promise(r => setTimeout(r, 3000));
          }
        }

        const typeScreen = await this.getScreenImage(sid);
        return { output: `Typed: ${textToType.slice(0, 120)}`, screenshot: typeScreen };
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
        // Target keystrokes to the CU session's active app so they don't leak
        // to whatever is frontmost. Resolver consults _native_app_mode, then
        // share_info / capture_target, then _browser_app (Chrome default).
        // Async variant: if no explicit binding, re-probe Chrome Bridge now to
        // recover from a flaky health check at session-create time.
        const keyApp = sessionId ? await this.resolveTargetAppAsync(sessionId) : null;
        if (keyApp) {
          payload.app = keyApp; // --app flag → AppleScript targets this process
          // Focus the window first so the AppleScript keystroke lands in the
          // correct process context. Critical for hotkeys like cmd+a whose
          // effect depends on which window has keyboard focus.
          try {
            await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'focus_window', text: keyApp,
            }, { timeout: 3000 });
            // Tiny settle delay for the window manager to finish the front swap.
            await new Promise(r => setTimeout(r, 150));
          } catch (err: any) {
            this.logger.debug(`key_press: focus_window "${keyApp}" failed (${err.message}); sending keystroke anyway`);
          }
          this.logger.log(`key_press: targeting "${keyApp}" process`);
        } else {
          this.logger.warn(`key_press: no resolvable target app for session ${sessionId} — keystroke "${target}" will go to whatever is frontmost`);
        }
        await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, payload, { timeout: ACTION_TIMEOUT_MS });
        await new Promise(r => setTimeout(r, 300));
        const keyScreen = await this.getScreenImage(sid);
        return { output: `Pressed: ${target}${keyApp ? ` (→ ${keyApp})` : ''}`, screenshot: keyScreen };
      }

      case 'open_app': {
        if (!target) return { output: 'open_app requires app name' };

        // Redirect browser-only services to navigate instead of trying to open as native app
        const browserOnlyMap: Record<string, string> = {
          'facebook': 'https://www.facebook.com',
          'github': 'https://github.com',
          'twitter': 'https://twitter.com',
          'x': 'https://x.com',
          'linkedin': 'https://www.linkedin.com',
          'reddit': 'https://www.reddit.com',
          'youtube': 'https://www.youtube.com',
          'google': 'https://www.google.com',
          'instagram': 'https://www.instagram.com',
        };
        const targetLower = target.toLowerCase().replace(/\s*(app|desktop)\s*/g, '').trim();
        const browserUrl = browserOnlyMap[targetLower];
        if (browserUrl) {
          this.logger.log(`open_app "${target}" → redirecting to navigate ${browserUrl} (browser-only service)`);
          return this.executeComputerAction(
            { ...step, action: 'navigate', target: browserUrl } as PlanStep,
            sessionId,
          );
        }

        // Determine which screen to open the app on.
        // Use the session's capture target screen, or default to screen 0 (primary).
        let targetScreenIdx = 0;
        try {
          const screensRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'list_screens',
          }, { timeout: 5000 });
          const screens = screensRes.data?.screens || [];
          // If session has a capture target with a specific screen, use that
          const openSession = sessionId ? sessions.get(sessionId) : undefined;
          const captureTarget = (openSession as any)?.capture_target;
          if (captureTarget?.target) {
            const idx = screens.findIndex((s: any) => s.name?.toLowerCase().includes(captureTarget.target!.toLowerCase()));
            if (idx >= 0) targetScreenIdx = idx;
          }
          // Default: use the largest non-primary screen (external monitor) if available,
          // since users typically want CU actions on the external display
          if (screens.length > 1 && targetScreenIdx === 0) {
            targetScreenIdx = 1; // prefer external monitor
          }
        } catch { /* use default screen 0 */ }

        // 1. Open app, move to target screen, and maximize (100vw x 100vh)
        const openRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
          tool: 'computer_action',
          action: 'open_application',
          text: target,
          x: targetScreenIdx, // x = target screen index for open_application
        }, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
        await new Promise(r => setTimeout(r, 1000));

        // 2. focus_window with verify. The new dev-agent focus_window returns
        // success=false if the app never became frontmost — retry up to 3 times
        // before proceeding, so we don't screenshot/describe the wrong window.
        let frontmostVerified = false;
        let lastFocusOutput = '';
        for (let focusAttempt = 0; focusAttempt < 3; focusAttempt++) {
          try {
            const focusRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action',
              action: 'focus_window',
              text: target,
            }, { timeout: ACTION_TIMEOUT_MS });
            lastFocusOutput = focusRes.data?.output || '';
            if (focusRes.data?.success) {
              frontmostVerified = true;
              break;
            }
            this.logger.warn(`open_app: focus_window returned success=false (attempt ${focusAttempt + 1}): ${lastFocusOutput.slice(0, 120)}`);
          } catch (err: any) {
            this.logger.warn(`open_app: focus_window threw on attempt ${focusAttempt + 1}: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 600 + 400 * focusAttempt));
        }
        await new Promise(r => setTimeout(r, 500));

        // 3. Take screenshot (full screen — captures all displays for native apps)
        const appScreen = await this.getScreenImage(sid);

        // 4. Read each screen separately with vision LLM (multi-monitor aware)
        let appOutput = frontmostVerified
          ? `Opened ${target}`
          : `Opened ${target} BUT could not verify it is frontmost — ${lastFocusOutput.slice(0, 200)}. The window may be minimized, on another Space, or hidden behind another app. Consider using switch_app or click on the Dock icon to bring it forward before continuing.`;
        try {
          const screensRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'list_screens',
          }, { timeout: 5000 });
          const screens = screensRes.data?.screens || [];
          const descs: string[] = [];

          for (const scr of screens) {
            try {
              const ssRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action', action: 'screenshot',
                screen_region: { x: scr.x, y: scr.y, width: scr.width, height: scr.height },
              }, { timeout: 10000 });
              const img = ssRes.data?.screenshot;
              if (!img || img.length < 10000) continue;

              const vRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
                user_message:
                  `I just opened "${target}". Describe this screenshot of "${scr.name}" screen. ` +
                  `List all visible windows, apps, and clickable UI elements. Where is "${target}"?`,
                context: {
                  system_override: 'Describe screenshot. List apps and UI elements visible.',
                  max_tokens: 600,
                  screen_image: img,
                },
              }, { timeout: 20000 });
              const desc = (vRes.data?.response_text || vRes.data?.response || '').trim();
              if (desc) descs.push(`[Screen: ${scr.name}]\n${desc}`);
            } catch { /* skip */ }
          }
          if (descs.length > 0) {
            appOutput = `App: ${target}\n\n${descs.join('\n\n')}`;
          }
        } catch {
          // Fallback: single screenshot
          if (appScreen) {
            try {
              const vRes = await axios.post(`${RESPONSE_URL}/internal/response/chat`, {
                user_message: `Describe this screenshot. I opened "${target}". List all visible UI elements.`,
                context: { system_override: 'Describe screenshot.', max_tokens: 800, screen_image: appScreen },
              }, { timeout: 20000 });
              const desc = (vRes.data?.response_text || vRes.data?.response || '').trim();
              if (desc) appOutput = `App: ${target}\n\n${desc}`;
            } catch { /* ignore */ }
          }
        }

        // Mark session as in native app mode so future read_screen uses OCR
        const appSession = sessions.get(sid);
        // Store the normalized app name for keystroke targeting.
        // macOS process names don't include "desktop", "app", etc.
        // "ChatGPT desktop" → "ChatGPT", "Finder app" → "Finder"
        const normalizedAppName = target
          .replace(/\s+(desktop|app|application)$/i, '')
          .trim();
        if (appSession) (appSession as any)._native_app_mode = normalizedAppName;

        return { output: appOutput, screenshot: appScreen };
      }

      case 'click_screen': {
        // Native screen click — uses screenshot + ui_parser to find element, then clicks at screen coordinates
        if (!target) return { output: 'click_screen requires element description' };
        const cleanClickTarget = target.replace(/^["'\s]+|["'\s]+$/g, '').trim();

        // ── Web-app redirect: if we're in a Chrome tab (no native_app_mode,
        // _work_window_opened was set by navigate, and _current_tab_hint
        // exists), try Chrome Bridge "click" FIRST. click_screen on a web app
        // is prone to picking up the wrong element (featured tiles, sidebars)
        // because the ui_parser works on a flat pixel image with no knowledge
        // of focused tab vs. background content. Chrome Bridge's DOM matching
        // respects the active tab and accessibility semantics.
        {
          const csSession = sessions.get(sid);
          const inBrowser = !!(csSession as any)?._work_window_opened &&
                            !(csSession as any)?._native_app_mode;
          if (inBrowser) {
            try {
              const domRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'computer_action',
                action: 'click_ui_element',
                text: cleanClickTarget,
              }, { timeout: 8000 });
              if (domRes?.data?.success) {
                this.logger.log(`click_screen → redirected to Chrome Bridge click (web app): "${cleanClickTarget}"`);
                await new Promise(r => setTimeout(r, 600));
                const afterScreen = await this.getScreenImage(sid);
                return {
                  output: `Clicked via Chrome Bridge (web app redirect): ${cleanClickTarget}`,
                  screenshot: afterScreen,
                };
              }
              this.logger.debug(`click_screen web-redirect: Chrome Bridge miss — falling back to native click_screen for "${cleanClickTarget}"`);
            } catch (err: any) {
              this.logger.debug(`click_screen web-redirect error: ${err.message} — falling back`);
            }
          }
        }

        // Pre-discard guard (same as `click` — applies to native click_screen too).
        // Refuse to click close/cancel/discard if there's uncommitted draft text.
        {
          const ctL = cleanClickTarget.toLowerCase();
          const isDiscard =
            /^(close|cancel|discard|dismiss|exit|back|×|x)$/i.test(ctL) ||
            /^(close|cancel|discard|dismiss)\s/i.test(ctL) ||
            /discard.*draft|close.*without.*saving|cancel.*post|leave.*page|exit.*editor/i.test(ctL);
          if (isDiscard) {
            const gs = sessions.get(sid);
            const recent = (gs?.plan || []).slice(-10);
            let draftT: typeof recent[0] | null = null;
            for (let i = recent.length - 1; i >= 0; i--) {
              const st = recent[i];
              if (st.status !== 'completed' || st.action !== 'type' || !st.output) continue;
              const o = st.output.trim();
              if (o.startsWith('Skipped:')) continue;
              const payload = o.replace(/^Typed:\s*/i, '').trim();
              // Include URLs this time — in a modal context (e.g. NotebookLM
              // Add Source) the URL IS the input that would be lost on close.
              if (payload.length < 10) continue;
              draftT = st;
              break;
            }
            if (draftT) {
              const dIdx = recent.indexOf(draftT);
              const pubAfter = recent.slice(dIdx + 1).some(s =>
                s.status === 'completed' && /^(click|click_screen)$/.test(s.action) &&
                /\b(post|publish|share|send|submit|tweet|insert|^add\b|ok|done|save|confirm|apply)\b/i.test(s.target || ''),
              );
              if (!pubAfter) {
                const preview = (draftT.output || '').replace(/^Typed:\s*/i, '').slice(0, 100);
                this.logger.warn(`click_screen: REFUSED discard "${cleanClickTarget}" — draft still uncommitted: "${preview}..."`);
                return {
                  output:
                    `⚠️ REFUSED to click_screen "${cleanClickTarget}" — this would discard your uncommitted input ` +
                    `("${preview}..."). Click the right submit: Insert/Add/Submit in a source dialog, Post/Publish/Share in a composer.`,
                };
              }
            }
          }
        }

        // Pre-publish check: if clicking a "Post/Publish/Submit" button, read the
        // composed content first and verify it's not duplicated or malformed.
        const isPublishClick = cleanClickTarget.toLowerCase().match(/^post$|publish|submit|send post/);
        if (isPublishClick) {
          try {
            // Read the current page text to check for duplicated content
            const pageRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'get_page_text',
            }, { timeout: 10000 });
            const pageText = (pageRes.data?.output || '') as string;

            // Check for obvious duplication (same sentence appearing twice)
            const sentences = pageText.split(/[.!?。]\s+/).filter(s => s.length > 30);
            const seen = new Set<string>();
            let hasDuplication = false;
            for (const s of sentences) {
              const norm = s.toLowerCase().trim().slice(0, 80);
              if (seen.has(norm)) { hasDuplication = true; break; }
              seen.add(norm);
            }

            if (hasDuplication) {
              this.logger.warn(`Pre-publish check: DUPLICATION detected — clearing and retyping`);
              // Clear the contenteditable and retype without duplication
              const clickSessCtx = sessionId ? sessions.get(sessionId) : undefined;
              const lastTypedStep = clickSessCtx?.plan
                ?.filter(s => s.status === 'completed' && s.action === 'type')
                ?.pop();
              if (lastTypedStep?.output) {
                // Extract the text that was typed (after "Typed: ")
                const typedText = lastTypedStep.output.replace(/^Typed:\s*/i, '').trim();
                if (typedText) {
                  // Pass replace=true so the bridge wipes the duplicated
                  // content before retyping (this path's whole purpose is to
                  // CLEAR the buggy double-typed text). Default is now
                  // append for the normal type path so multi-step bilingual
                  // posts don't lose earlier paragraphs.
                  await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                    tool: 'computer_action', action: 'chrome_bridge_type', text: typedText, replace: true,
                  }, { timeout: 15000 }).catch(() => {});
                  await new Promise(r => setTimeout(r, 500));
                  this.logger.log(`Pre-publish: re-typed content without duplication`);
                }
              }
            } else {
              this.logger.log(`Pre-publish check: content looks clean`);
            }
          } catch { /* continue with publish */ }
        }

        // 0. Focus the active app/browser first to prevent cross-screen mouse chaos
        const clickSess = sessionId ? sessions.get(sessionId) : undefined;
        const clickApp = (clickSess as any)?._native_app_mode;
        if (clickApp) {
          await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'focus_window', text: clickApp,
          }, { timeout: 5000 }).catch(() => {});
        } else {
          // Browser mode — focus Chrome
          await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'focus_window', text: 'Google Chrome',
          }, { timeout: 5000 }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 300));

        // 1. Try Chrome Bridge DOM click first (trusted events — works on Facebook, etc.)
        let domClicked = false;
        try {
          const domRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action',
            action: 'chrome_bridge_click',
            text: cleanClickTarget,
          }, { timeout: 10000 });
          if (domRes.data?.success) {
            this.logger.log(`click_screen: DOM click succeeded for "${cleanClickTarget.slice(0, 40)}"`);
            domClicked = true;
          } else {
            // Chrome Bridge responded but couldn't click — log why so we can see why we fell back to pixels
            const reason = domRes.data?.output || domRes.data?.error || 'no success flag';
            this.logger.warn(`click_screen: Chrome Bridge declined "${cleanClickTarget.slice(0, 40)}" → falling back to pixel: ${String(reason).slice(0, 120)}`);
          }
        } catch (e: any) {
          this.logger.warn(`click_screen: Chrome Bridge threw for "${cleanClickTarget.slice(0, 40)}" → falling back to pixel: ${e.message?.slice(0, 120)}`);
        }

        // 2. Fallback: pixel click via click_ui_element (OCR/GroundingDINO)
        let pixelClicked = false;
        if (!domClicked) {
          try {
            const nativeApp = (sessions.get(sid) as any)?._native_app_name;
            const pixelRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action',
              action: 'click_ui_element',
              text: cleanClickTarget,
              ...(nativeApp ? { app: nativeApp } : {}),
            }, { timeout: 15000 });
            pixelClicked = !!pixelRes.data?.success;
          } catch { /* failed */ }
        }

        // 3. If BOTH methods failed → request user click assist via mobile
        if (!domClicked && !pixelClicked && sessionId) {
          const assistScreen = await this.getScreenImage(sid);
          if (assistScreen) {
            await this.requestUserClickAssist(sessionId, assistScreen, cleanClickTarget);
            const sess = sessions.get(sessionId);
            if (sess?.status === 'awaiting_click_assist') {
              return {
                output: `Could not find "${cleanClickTarget}" — asking user to select element`,
                screenshot: assistScreen,
              };
            }
          }
        }

        await new Promise(r => setTimeout(r, 800));
        const clickScreen = await this.getScreenImage(sid);
        return {
          output: domClicked
            ? `Clicked "${cleanClickTarget}" via DOM`
            : pixelClicked
              ? `Clicked "${cleanClickTarget}" on screen`
              : `Attempted click on "${cleanClickTarget}"`,
          screenshot: clickScreen,
        };
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

      case 'switch_tab': {
        // Activate an existing Chrome tab by title or URL match (no navigation).
        if (!target) return { output: 'switch_tab requires target tab name or URL' };
        const cleanTabTarget = target.replace(/^["'\s]+|["'\s]+$/g, '').trim();

        // Reject degenerate queries — LLM occasionally emits switch_tab with a
        // bare tab index ("2", "3") expecting position-based addressing, but
        // the bridge does substring match on title/URL. "2" then matches
        // "(2) Facebook" or any URL fragment containing 2, sending the agent
        // to the wrong tab. Force a real navigate instead by failing here.
        if (cleanTabTarget.length < 3 || /^\d+$/.test(cleanTabTarget)) {
          this.logger.warn(`switch_tab: REJECTED degenerate target "${cleanTabTarget}" — too short or digit-only. Use navigate with a full URL instead.`);
          return {
            output:
              `switch_tab refused: "${cleanTabTarget}" is too short or numeric. ` +
              `Tab matching is substring-based on title/URL, so short numeric queries match unrelated tabs. ` +
              `Use ACTION: navigate with the full URL (e.g. https://github.com/owner/repo/issues/2), ` +
              `or use a longer distinctive substring of the tab title.`,
          };
        }

        let switched = false;
        // 1. Primary: dev-agent's switch_tab action (uses Chrome Bridge's
        // chrome.tabs API, matching by title OR url substring, case-insensitive).
        try {
          const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
            tool: 'computer_action', action: 'switch_tab', text: cleanTabTarget,
          }, { timeout: 10000 }).catch(() => null);
          if (res?.data?.success) {
            switched = true;
            this.logger.log(`switch_tab via Chrome Bridge: ${res.data.output}`);
          } else {
            this.logger.warn(`switch_tab via Chrome Bridge failed: ${res?.data?.output || 'no response'}`);
          }
        } catch (err: any) {
          this.logger.warn(`switch_tab axios error: ${err.message}`);
        }

        // 2. Fallback: keyboard shortcut (Cmd+N on Mac) iteration — only tries if
        // Chrome Bridge didn't work (extension not loaded / bridge disconnected).
        if (!switched) {
          try {
            await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'click_ui_element', text: cleanTabTarget,
            }, { timeout: 12000 });
            switched = true;
          } catch { /* continue */ }
        }

        await new Promise(r => setTimeout(r, 500));

        // Update _current_tab_hint to the new tab's URL so subsequent
        // clicks and reads target the correct tab
        if (switched) {
          try {
            const ptRes = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, {
              tool: 'computer_action', action: 'get_page_text',
            }, { timeout: 8000 });
            if (ptRes.data?.success && ptRes.data.output) {
              const urlMatch = (ptRes.data.output as string).match(/^URL:\s*(.+)$/m);
              if (urlMatch) {
                const s = sessions.get(sid);
                if (s) {
                  try {
                    const parsed = new URL(urlMatch[1].trim());
                    (s as any)._current_tab_hint = parsed.hostname + parsed.pathname;
                    this.logger.log(`Tab switch updated hint: ${(s as any)._current_tab_hint}`);
                  } catch { /* ignore parse error */ }
                }
              }
            }
          } catch { /* best effort */ }
        }

        const tabScreen = await this.getScreenImage(sid);
        return {
          output: switched ? `Switched to tab: ${cleanTabTarget}` : `Could not find tab: ${cleanTabTarget}`,
          screenshot: tabScreen,
        };
      }

      default: {
        this.logger.warn(`Unknown plan action "${action}" — capturing screen`);
        const fallbackScreen = await this.getScreenImage(sid);
        return { output: `Unknown action: ${action}`, screenshot: fallbackScreen };
      }
    }
  }
}
