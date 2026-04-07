import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { RedisEventService } from '../events/redis-event.service';
import { LangfuseService } from '../events/langfuse.service';
import { SessionConfigService } from '../session/session.service';

export interface InteractionRequest {
  user_message: string;
  session_id?: string;
  context?: Record<string, any>;
}

export interface ContextBudgetInfo {
  context_window: number;
  input_budget: number;
  input_used: number;
  input_remaining: number;
  breakdown: Record<string, number>;
}

export interface InteractionResponse {
  session_id: string;
  response: string;
  reasoning_graph: Record<string, any>;
  confidence: number;
  reasoning_trace: string[];
  conclusion?: string;
  route?: string;
  clarifying_questions?: string[];
  context_budget?: ContextBudgetInfo;
}

const INTERPRETER_URL = process.env.INTERPRETER_URL || 'http://localhost:8001';
const GRAPH_BUILDER_URL = process.env.GRAPH_BUILDER_URL || 'http://localhost:8002';
const LOGIC_ENGINE_URL = process.env.LOGIC_ENGINE_URL || 'http://localhost:8003';
const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';
const RESPONSE_URL = process.env.RESPONSE_URL || 'http://localhost:8005';
const TEACHING_URL = process.env.TEACHING_URL || 'http://localhost:8006';
const TOOL_EXECUTOR_URL = process.env.TOOL_EXECUTOR_URL || 'http://localhost:8007';
const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const OBSERVER_URL = process.env.OBSERVER_URL || 'http://localhost:8009';
const ARTIFACT_URL = process.env.ARTIFACT_SERVICE_URL || 'http://artifact-service:8012';

const MAX_TOOL_ITERATIONS = parseInt(process.env.MAX_TOOL_ITERATIONS || '50', 10);
/** When true, Langfuse tool-plan spans include truncated full request + model output (PII/size risk). */
const OASIS_DEBUG_TOOL_PLAN_PAYLOAD =
  process.env.OASIS_DEBUG_TOOL_PLAN_PAYLOAD === 'true' || process.env.OASIS_DEBUG_TOOL_PLAN_PAYLOAD === '1';
const OASIS_DEBUG_TOOL_PLAN_MAX_CHARS = parseInt(process.env.OASIS_DEBUG_TOOL_PLAN_MAX_CHARS || '16000', 10);
const CONTEXT_WINDOW = parseInt(process.env.OASIS_CONTEXT_WINDOW || '8192', 10);
const KEEP_RECENT_MESSAGES = 12;

/** Rough token estimate: ~4 chars per token for English. */
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** If chat history exceeds 25% of context window (or 8192 tokens), condense older messages.
 *  We keep the threshold moderate because most of the context budget goes to tool results and system prompts. */
const HISTORY_TOKEN_CAP = Math.min(Math.floor(CONTEXT_WINDOW * 0.25), 8192);

/** Interpreter context: always keep `Conversation summary` system rows plus recent turns. Plain `slice(-6)` can drop the summary when the condensed window grows. */
function buildInterpreterChatHistory(
  chatHistory: Array<{ role: string; content: string }>,
  maxNonSummaryTurns = 12,
): Array<{ role: string; content: string }> {
  const isConversationSummary = (m: { role: string; content: string }) =>
    m.role === 'system' && m.content.toLowerCase().includes('conversation summary:');
  const summaries = chatHistory.filter(isConversationSummary);
  const rest = chatHistory.filter(m => !isConversationSummary(m));
  const recentRest = rest.slice(-maxNonSummaryTurns);
  return summaries.length > 0 ? [summaries[summaries.length - 1]!, ...recentRest] : recentRest;
}

async function condenseChatHistoryIfNeeded(
  messages: Array<{ role: string; content: string }>,
): Promise<Array<{ role: string; content: string }>> {
  const fullText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const estimatedTokens = estimateTokens(fullText);
  if (estimatedTokens <= HISTORY_TOKEN_CAP) return messages;

  const toSummarize = messages.slice(0, -KEEP_RECENT_MESSAGES);
  const recent = messages.slice(-KEEP_RECENT_MESSAGES);
  if (toSummarize.length === 0) return messages;

  try {
    const res = await axiosWithRetry(
      'post',
      `${RESPONSE_URL}/internal/response/summarize-history`,
      { messages: toSummarize },
      undefined,
      { timeout: LLM_TIMEOUT_MS },
    );
    const summary = res.data?.summary || '[Conversation summary]';
    return [
      { role: 'system', content: `Conversation summary: ${summary}` },
      ...recent,
    ];
  } catch {
    return messages;
  }
}

/** Extract "wall" / "aha" insights from failed tool results so we avoid repeating the same mistake. */
function extractWallsFromToolResults(
  results: Array<{ tool: string; path?: string; command?: string; pattern?: string; url?: string; success: boolean; output: string; blocked?: boolean }>,
): string[] {
  const walls: string[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.success || r.blocked) continue;
    const out = (r.output || '').toLowerCase();
    const path = r.path || '';
    const cmd = (r.command || '').trim();

    // Path / file does not exist
    if (
      (r.tool === 'read_file' || r.tool === 'list_dir' || r.tool === 'read_worktree_file') &&
      (out.includes('no such file') || out.includes('not found') || out.includes('enoent') || out.includes('does not exist'))
    ) {
      const key = `path:${path}`;
      if (!seen.has(key) && path) {
        seen.add(key);
        walls.push(`Path does not exist: ${path}`);
      }
    }
    // bash / grep found nothing
    else if (r.tool === 'bash' && (out.includes('no such file') || out.includes('not found'))) {
      const match = cmd.match(/(?:cat|ls|find|grep)\s+['"]?([^\s'"]+)['"]?/);
      const target = match ? match[1] : (path || cmd.slice(0, 80));
      const key = `bash:${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        walls.push(`Path/pattern not found (bash): ${target}`);
      }
    }
    // grep tool or bash grep returned empty
    else if ((r.tool === 'grep' || (r.tool === 'bash' && cmd.includes('grep'))) && (out === '' || out.includes('no matches') || out.trim().length < 20)) {
      const grepPattern = r.tool === 'grep' ? (r.pattern || 'pattern') : (cmd.match(/grep\s+['"]?([^'"]+)['"]?/) ? cmd.match(/grep\s+['"]?([^'"]+)['"]?/)![1] : 'pattern');
      const key = `grep:${grepPattern}`;
      if (!seen.has(key)) {
        seen.add(key);
        walls.push(`grep for "${grepPattern}" found nothing — try different path or pattern`);
      }
    }
    // edit_file old_string not found
    else if (r.tool === 'edit_file' && !r.success) {
      const editPath = path || '(unknown file)';
      const key = `edit:${editPath}:${(r.output || '').slice(0, 60)}`;
      if (!seen.has(key) && path) {
        seen.add(key);
        const errLine = (r.output || '').split('\n').find(l =>
          /old_string|not found|could not find|no match|ambiguous/i.test(l),
        ) || '';
        const errHint = errLine ? ` Error: ${errLine.trim().slice(0, 150)}` : '';
        walls.push(
          `edit_file FAILED on ${editPath}${errHint} — re-read with read_worktree_file (start_line/end_line) then retry with exact text from output`,
        );
      }
    }
    // apply_patch / git apply mismatch — per-file, include error detail
    else if (r.tool === 'apply_patch' && !r.success) {
      const patchPath = path || '(unknown file)';
      const key = `apply_patch:${patchPath}:${(r.output || '').slice(0, 60)}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Extract the first meaningful error line from git apply output
        const errLine = (r.output || '').split('\n').find(l =>
          /error:|patch does not apply|corrupt|does not exist|trailing whitespace|No such file/i.test(l),
        ) || '';
        const errHint = errLine ? ` Error: ${errLine.trim().slice(0, 150)}` : '';
        walls.push(
          `apply_patch FAILED on ${patchPath}${errHint} — MUST read_worktree_file (with start_line/end_line) to see CURRENT content, then regenerate unified diff. Check: "--- a/" "+++ b/" prefixes, correct @@ line counts, leading space on context lines, repo-relative paths.`,
        );
      }
    }
    // Generic: capture path/command that failed
    else if (path && (out.includes('error') || out.includes('failed'))) {
      const key = `fail:${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        walls.push(`Failed: ${r.tool} ${path} — try different path or approach`);
      }
    }
  }
  return walls;
}

// Tools handled by the dev-agent (native host service) instead of tool-executor (Docker).
// bash MUST run on the dev-agent so npm/pnpm/yarn/pip can execute in a git worktree cwd (Docker bash only sees container /workspace).
const DEV_AGENT_TOOLS = new Set([
  'create_worktree',
  'write_file',
  'edit_file',
  'apply_patch',
  'read_worktree_file',
  'get_diff',
  'bash',
  'computer_action',
]);

const TOOL_EXECUTOR_TOOLS = new Set([
  'read_file',
  'list_dir',
  'grep',
  'find_files',
  'browse_url',
]);

const KNOWN_CALL_TOOLS_SORTED = [...new Set([...DEV_AGENT_TOOLS, ...TOOL_EXECUTOR_TOOLS])].sort();

// Tools handled entirely by the gateway (not forwarded to executor or dev-agent)
const GATEWAY_HANDLED_TOOLS = new Set([
  'search_artifacts',
  'read_artifact',
]);

const TOOL_NAME_ALIASES: Record<string, string> = {
  edit: 'edit_file',
  search_replace: 'edit_file',
  apply_patch: 'apply_patch',
  patch: 'apply_patch',
  unified_diff: 'apply_patch',
  replace: 'edit_file',
  read_dir: 'list_dir',
  listdir: 'list_dir',
  dir_list: 'list_dir',
  open_file: 'read_file',
  file_search: 'find_files',
  glob: 'find_files',
  rg: 'grep',
  ripgrep: 'grep',
  shell: 'bash',
  terminal: 'bash',
  run_terminal_cmd: 'bash',
  run_terminal: 'bash',
  worktree_create: 'create_worktree',
  wt_read: 'read_worktree_file',
  read_worktree: 'read_worktree_file',
  show_diff: 'get_diff',
  diff: 'get_diff',
  computer: 'computer_action',
  mouse_click: 'computer_action',
  screen: 'computer_action',
  screenshot: 'computer_action',
  artifact_search: 'search_artifacts',
  search_artifact: 'search_artifacts',
  query_artifacts: 'search_artifacts',
  find_artifacts: 'search_artifacts',
  get_artifact: 'read_artifact',
  fetch_artifact: 'read_artifact',
  artifact_content: 'read_artifact',
  view_artifact: 'read_artifact',
};

function isKnownExecutorTool(tool: string): boolean {
  return DEV_AGENT_TOOLS.has(tool) || TOOL_EXECUTOR_TOOLS.has(tool) || GATEWAY_HANDLED_TOOLS.has(tool);
}

/**
 * Tool-executor uses `/workspace` as repo root; dev-agent worktrees expect paths relative to repo root.
 * Strip a leading `/workspace` so model can reuse the same path shape as read_file/grep.
 */
function normalizeDevAgentFilePath(p: string): string {
  const s = p.trim();
  if (!s) return s;
  const norm = s.replace(/\\/g, '/');
  if (norm === '/workspace' || norm === '/workspace/') return '';
  if (norm.startsWith('/workspace/')) {
    const rest = norm.slice('/workspace/'.length).replace(/^\/+/, '');
    return rest || '';
  }
  return s;
}

/** Trailing lone `.` (e.g. `CodeBlock.`) breaks file lookup — dev-agent also tries extensions. */
function repairAmbiguousDevPath(p: string): string {
  const t = p.trim();
  if (t.endsWith('.') && !t.endsWith('..')) return t.slice(0, -1);
  return t;
}

/** Structured stats from read_file / read_worktree_file (tool-executor + dev-agent). */
interface ReadFileMetadata {
  file_size_bytes: number;
  returned_bytes: number;
  total_lines: number;
  truncated_by_line_cap: boolean;
  truncated_by_byte_cap: boolean;
  source_line_start?: number | null;
  source_line_end?: number | null;
  next_chunk_start_line?: number | null;
  has_more_lines_below: boolean;
  has_more_lines_above: boolean;
}

const CACHED_DUPLICATE_READ_TOOLS = new Set(['read_file', 'read_worktree_file']);

/**
 * Replace smart/curly quotes with straight ASCII equivalents.
 * LLMs sometimes emit \u201c \u201d \u2018 \u2019 in code content,
 * which breaks syntax when written to files.
 */
function stripSmartQuotes(s: string | undefined): string | undefined {
  if (!s) return s;
  return s
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
}

/** Normalize paths so duplicate detection treats /workspace/apps/x and apps/x as the same. */
function normalizePathForToolSignature(p: string | undefined): string {
  if (!p) return '';
  return normalizeDevAgentFilePath(p) || p.trim();
}

/** Last successful create_worktree worktree_id from this session's tool results (for bash cwd). */
function resolveActiveWorktreeIdFromResults(
  results: Array<{ tool: string; success?: boolean; worktree_id?: string; output?: string; blocked?: boolean }>,
): string | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (r.tool !== 'create_worktree' || !r.success || r.blocked) continue;
    if (r.worktree_id && String(r.worktree_id).trim()) {
      return String(r.worktree_id).trim();
    }
    const m = (r.output || '').match(/Worktree\s+['"]([^'"]+)['"]\s+created/i);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

const PACKAGE_INSTALL_CMD_RE =
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\buv\s+(pip\s+)?add\b/i;

function commandLooksLikePackageInstall(command: string | undefined): boolean {
  return PACKAGE_INSTALL_CMD_RE.test(command || '');
}

/** Same character rules as dev-agent `_WORKTREE_NAME_RE` (no spaces). */
const WORKTREE_ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

function stripAngleBracketParam(raw: string): string {
  const t = raw.trim();
  const m = /^<([^<>]*)>$/.exec(t);
  if (m) return m[1].trim();
  return t;
}

function isValidWorktreeIdToken(id: string): boolean {
  return id.length > 0 && WORKTREE_ID_TOKEN_RE.test(id);
}

/** Model pasted prompt examples like `<from create_worktree>` instead of a real id. */
function looksLikeWorktreeDocPlaceholder(stripped: string, raw: string): boolean {
  if (!stripped) return true;
  if (/\s/.test(stripped)) return true;
  const lower = stripped.toLowerCase();
  if (/placeholder|param_worktree|example|tbd|todo/.test(lower)) return true;
  if (/from\s*create|create_worktree|your\s*worktree/.test(lower)) return true;
  if ((raw.includes('<') || raw.includes('>')) && !isValidWorktreeIdToken(stripped)) return true;
  return false;
}

/**
 * Real worktree id from plan, or last successful create_worktree in this session.
 * Rejects documentation placeholders so we do not hit dev-agent with a fake folder name.
 */
function coalesceDevAgentWorktreeId(
  rawWorktreeId: string | undefined,
  toolResults: Array<{ tool: string; success?: boolean; worktree_id?: string; output?: string; blocked?: boolean }>,
): string | undefined {
  const raw = rawWorktreeId || '';
  const stripped = stripAngleBracketParam(raw);
  if (isValidWorktreeIdToken(stripped) && !looksLikeWorktreeDocPlaceholder(stripped, raw)) {
    return stripped;
  }
  return resolveActiveWorktreeIdFromResults(toolResults);
}

const DEV_AGENT_TOOLS_NEED_WORKTREE = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'read_worktree_file',
  'get_diff',
]);

const EXPLORATION_TOOLS = new Set(['grep', 'find_files', 'list_dir', 'read_file', 'browse_url']);

const EXPLORATION_BROADEN_STAGNATION_MIN = 2;
const EXPLORATION_IMPLEMENT_STAGNATION_MIN = 3;
const EXPLORATION_MIN_ACTIONS_FOR_BROADEN = 2;

interface ExplorationState {
  stagnation: number;
  distinctRoots: Set<string>;
  exploratoryActionCount: number;
}

/**
 * Whether stagnation guidance should push toward create_worktree/edit (vs only broadening search).
 * Uses interpreter intent; in **autonomous** mode most sessions are expected to land code, so we
 * escalate unless intent is clearly non-code (greet / teach).
 */
function toolUseNeedsImplementationEscalation(semanticStructure: any, autonomousMode?: boolean): boolean {
  const intent = String(semanticStructure?.intent ?? '')
    .toLowerCase()
    .trim();
  if (autonomousMode) {
    if (intent === 'greet' || intent === 'teach') return false;
    return true;
  }
  if (!intent) return false;
  return intent === 'fix' || intent === 'implement';
}

function explorationPathRoot(p: string | undefined): string | null {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim().replace(/\\/g, '/');
  if (s.startsWith('/workspace/')) s = s.slice('/workspace/'.length);
  else if (s === '/workspace' || s.startsWith('/workspace')) s = s.replace(/^\/workspace\/?/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function explorationOutcomeExpands(r: {
  tool: string;
  success: boolean;
  blocked?: boolean;
  output: string;
}): boolean {
  if (r.blocked || !r.success) return false;
  const out = (r.output || '').trim();
  if (r.tool === 'read_file' && out.length >= 60) return true;
  if (r.tool === 'grep' && out.length >= 80) return true;
  if (r.tool === 'find_files' && out.length >= 35) return true;
  if (r.tool === 'list_dir' && out.length >= 90) return true;
  if (r.tool === 'browse_url' && out.length >= 80) return true;
  return false;
}

function explorationOutcomeBarren(r: {
  tool: string;
  success: boolean;
  blocked?: boolean;
  output: string;
}): boolean {
  const raw = r.output || '';
  if (raw.includes('DUPLICATE CALL BLOCKED')) return true;
  if (r.blocked) return true;
  if (!r.success) return true;
  const out = raw.trim();
  const ol = out.toLowerCase();
  if (out.length < 28) return true;
  if (
    ol.includes('no matches') ||
    ol.includes('no such file') ||
    ol.includes('not found') ||
    ol.includes('enoent') ||
    ol.includes('file not found')
  ) {
    return true;
  }
  return false;
}

function explorationFloorSatisfied(
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean; output: string }>,
  distinctRoots: Set<string>,
): boolean {
  const hadRead = toolResults.some(
    (r) => r.tool === 'read_file' && r.success && !r.blocked && (r.output || '').trim().length >= 60,
  );
  if (hadRead) return true;
  if (distinctRoots.size >= 3) return true;
  const exploratory = toolResults.filter((r) => EXPLORATION_TOOLS.has(r.tool));
  if (exploratory.length >= 4 && exploratory.some((r) => explorationOutcomeExpands(r))) return true;
  return false;
}

function hasSuccessfulImplementationProgress(
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean }>,
): boolean {
  return toolResults.some(
    (r) =>
      !r.blocked &&
      r.success &&
      (r.tool === 'create_worktree' ||
        r.tool === 'write_file' ||
        r.tool === 'edit_file' ||
        r.tool === 'apply_patch' ||
        r.tool === 'get_diff'),
  );
}

/** True once a file was actually written/patched (worktree alone is not enough). */
function hasSuccessfulCodeMutation(
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean }>,
): boolean {
  return toolResults.some(
    (r) =>
      !r.blocked &&
      r.success &&
      (r.tool === 'edit_file' || r.tool === 'write_file' || r.tool === 'apply_patch'),
  );
}

function hasSuccessfulWorktree(toolResults: Array<{ tool: string; success: boolean; blocked?: boolean }>): boolean {
  return toolResults.some((r) => !r.blocked && r.success && r.tool === 'create_worktree');
}

function lastSuccessfulWorktreeIndex(
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean }>,
): number {
  let last = -1;
  for (let i = 0; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (r.tool === 'create_worktree' && r.success && !r.blocked) last = i;
  }
  return last;
}

function exploratoryExploreSuccessCount(
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean }>,
): number {
  return toolResults.filter((r) => EXPLORATION_TOOLS.has(r.tool) && r.success && !r.blocked).length;
}

/** Read-only tools after the last successful create_worktree — detects "has worktree but keeps grepping". */
function exploratorySuccessesAfterLastWorktree(
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean }>,
): number {
  const idx = lastSuccessfulWorktreeIndex(toolResults);
  if (idx < 0) return 0;
  return toolResults
    .slice(idx + 1)
    .filter((r) => EXPLORATION_TOOLS.has(r.tool) && r.success && !r.blocked).length;
}

/**
 * For fix/implement intent, these tools can "expand" output but still mean no code change —
 * counting them toward stagnation avoids resetting to 0 on every read_file.
 */
const EXPLORE_TOOLS_THAT_STALL_IMPLEMENTATION = new Set([
  'read_file',
  'grep',
  'list_dir',
  'find_files',
  'browse_url',
]);

function updateExplorationStateFromToolResult(
  r: { tool: string; path?: string; success: boolean; blocked?: boolean; output: string },
  state: ExplorationState,
  semanticStructure?: any,
  autonomousMode?: boolean,
): void {
  const t = r.tool;
  if (
    t === 'create_worktree' ||
    t === 'write_file' ||
    t === 'edit_file' ||
    t === 'apply_patch' ||
    t === 'read_worktree_file' ||
    t === 'get_diff'
  ) {
    if (r.success && !r.blocked) {
      state.stagnation = 0;
    }
    return;
  }
  if (!EXPLORATION_TOOLS.has(t)) return;

  state.exploratoryActionCount += 1;
  const root = explorationPathRoot(r.path);
  if (root) state.distinctRoots.add(root);

  const implEsc = toolUseNeedsImplementationEscalation(semanticStructure, autonomousMode);
  if (explorationOutcomeExpands(r)) {
    if (implEsc && EXPLORE_TOOLS_THAT_STALL_IMPLEMENTATION.has(t)) {
      state.stagnation = Math.min(state.stagnation + 1, 40);
    } else {
      state.stagnation = 0;
    }
  } else if (explorationOutcomeBarren(r)) {
    state.stagnation += 1;
  } else {
    state.stagnation = 0;
  }
}

function buildExplorationEscalationGuidance(
  semanticStructure: any,
  toolResults: Array<{ tool: string; success: boolean; blocked?: boolean; output: string }>,
  state: ExplorationState,
  autonomousMode?: boolean,
): 'broaden' | 'implement' | null {
  if (!toolUseNeedsImplementationEscalation(semanticStructure, autonomousMode)) return null;
  if (toolResults.length === 0) return null;
  // Worktree alone does not satisfy "implementation" — keep nudging until edit_file/write_file succeeds.
  if (hasSuccessfulCodeMutation(toolResults)) return null;

  const floor = explorationFloorSatisfied(toolResults, state.distinctRoots);

  if (
    !floor &&
    state.stagnation >= EXPLORATION_BROADEN_STAGNATION_MIN &&
    state.exploratoryActionCount >= EXPLORATION_MIN_ACTIONS_FOR_BROADEN
  ) {
    return 'broaden';
  }
  if (floor && state.stagnation >= EXPLORATION_IMPLEMENT_STAGNATION_MIN) {
    return 'implement';
  }
  return null;
}

const EXPLORATION_GUIDANCE_BROADEN = `[EXPLORATION: BROADEN] You are exploring too much. Use the Knowledge Graph symbols you already have. Stop listing directories and START editing. Next action MUST be create_worktree → edit_file/write_file/apply_patch.`;

const EXPLORATION_GUIDANCE_IMPLEMENT = `[IMPLEMENTATION: STOP EXPLORING NOW] You have enough context. The Knowledge Graph contains the symbols you need. STOP reading files and START implementing: create_worktree (PARAM_NAME: short id), then edit_file or write_file on the target path, then get_diff. NO MORE EXPLORATION.`;

const AUTONOMOUS_IMPLEMENT_NUDGE_AFTER_EXPLORE = 2;  // Nudge after just 2 reads
const AUTONOMOUS_FORCE_WORKTREE_AFTER_EXPLORE = 3;   // Force worktree at 3 reads
const AUTONOMOUS_WORKTREE_THEN_EDIT_NUDGE_AFTER_READ = 1;  // Nudge to edit immediately after worktree

function autonomousExploreWithoutEditMessage(count: number): string {
  return (
    `[FORCE ACTION: STOP EXPLORING] ${count} read-only tools is TOO MANY. You are stalling. ` +
    `The Knowledge Graph already contains the symbols you need. ` +
    `NEXT ACTION MUST BE: create_worktree → edit_file/write_file/apply_patch. ` +
    `NO MORE grep. NO MORE list_dir. IMPLEMENT NOW.`
  );
}

function autonomousWorktreeButNoEditMessage(readsAfterWt: number): string {
  return (
    `[FORCE ACTION: EDIT NOW] Worktree exists but you did ${readsAfterWt} more read(s) instead of editing. ` +
    `STOP EXPLORING. NEXT ACTION MUST BE edit_file or write_file with the worktree_id. ` +
    `Use apply_patch for multi-line changes. DO NOT read another file.`
  );
}

/**
 * Observer feedback on every hop includes routine "goal not met" + step-progress text. Treating any
 * non-empty string as a signal to regenerate free thoughts + decision caused a full rethink every iteration.
 * Only refresh when the tool failed or feedback carries an escalation / structural marker.
 */
function feedbackWarrantsReasoningRefresh(feedback: string | null | undefined): boolean {
  const f = (feedback || '').trim();
  if (!f) return false;
  const markers = [
    '[FORCE ACTION]',
    '[SYSTEM: The upfront plan was revised',
    'OVERTHINKING DETECTED',
    'DUPLICATE CALL BLOCKED',
    '[EXPLORATION: BROADEN]',
    '[IMPLEMENTATION: STOP EXPLORING]',
    '[AUTONOMOUS — IMPLEMENT GOAL]',
    '[AUTONOMOUS — EDIT NOW]',
    '⚠️ TEACHING REQUIRED',
    'Validation failed:',
    'Parameter validation failed',
    '[Logic Engine update:',
  ];
  return markers.some(m => f.includes(m));
}

/** When ACTION is prose ('Use the `grep` tool to…'), infer the real tool id. */
function extractToolFromProse(raw: string): string | undefined {
  const allowed = new Set<string>([...DEV_AGENT_TOOLS, ...TOOL_EXECUTOR_TOOLS]);
  const text = (raw ?? '').trim();
  if (!text) return undefined;
  const candidates: { start: number; tool: string }[] = [];

  const tick = /`([a-z][a-z0-9_]*)`/gi;
  let mm: RegExpExecArray | null;
  while ((mm = tick.exec(text)) !== null) {
    const w = mm[1].toLowerCase().replace(/-/g, '_');
    const mapped = TOOL_NAME_ALIASES[w] ?? w;
    if (allowed.has(mapped)) candidates.push({ start: mm.index, tool: mapped });
  }

  const sortedTools = [...allowed].sort((a, b) => b.length - a.length);
  for (const t of sortedTools) {
    const esc = t.replace(/_/g, '[_]');
    const re1 = new RegExp(`\\b${esc}\\b`, 'i');
    const m1 = re1.exec(text);
    if (m1) candidates.push({ start: m1.index, tool: t });
    const parts = t.split('_');
    if (parts.length > 1) {
      const inner = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[_\\s]+');
      const re2 = new RegExp(`\\b${inner}\\b`, 'i');
      const m2 = re2.exec(text);
      if (m2) candidates.push({ start: m2.index, tool: t });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.start - b.start || b.tool.length - a.tool.length);
  return candidates[0].tool;
}

function canonicalizeToolAlias(rawTool: string): { tool?: string; reason?: string } {
  const allowed = new Set<string>([...DEV_AGENT_TOOLS, ...TOOL_EXECUTOR_TOOLS]);

  let s = (rawTool ?? '').toString().trim();
  // Strip common quoting artifacts from LLM outputs, e.g. ACTION: "grep"
  s = s.replace(/^["']/, '').replace(/["']$/, '');
  if (!s) return { reason: 'Missing tool name.' };

  const normalized = s.toLowerCase().trim().replace(/-/g, '_').replace(/\s+/g, '');

  // No desktop IDE/editor integrations; if the model hallucinates them, explain.
  const forbidden = [
    'vscode',
    'visualstudio',
    'sublime',
    'jetbrains',
    'intellij',
    'webstorm',
    'pycharm',
    'atomeditor',
    'zededitor',
    'eclipse',
    'xcode',
  ];
  const compactNoUnderscore = normalized.replace(/_/g, '');
  if (forbidden.some((m) => compactNoUnderscore.includes(m))) {
    return {
      reason:
        `You used ${JSON.stringify(rawTool)} but there is NO integration with desktop IDEs or editors. ` +
        'The only way to change code is create_worktree → edit_file (or write_file → get_diff).',
    };
  }

  const mapped =
    (allowed.has(normalized) ? normalized : undefined) ||
    TOOL_NAME_ALIASES[normalized] ||
    TOOL_NAME_ALIASES[normalized.replace(/_/g, '')] ||
    undefined;

  if (mapped && allowed.has(mapped)) return { tool: mapped };

  const fromProse = extractToolFromProse(s);
  if (fromProse && allowed.has(fromProse)) return { tool: fromProse };

  return { reason: `Unknown tool ${JSON.stringify(rawTool)}. Allowed: ${[...allowed].join(', ')}` };
}

/**
 * Best-effort JSON extraction for LLM outputs.
 *
 * Mirrors the repo's Python `packages/shared_utils/json_utils.py` approach:
 * - extract the first JSON-ish object/array from text
 * - try parsing
 * - if parsing fails, repair truncated JSON and "loose JSON" (trailing commas,
 *   unquoted keys, single-quoted strings, bareword string values)
 */
function extractAndParseJson(text: string): any | null {
  const input = (text ?? '').trim();
  if (!input) return null;

  const tryParse = (candidate: string): any | null => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  const repairTruncatedJson = (s: string): string => {
    let t = (s ?? '').trim();
    if (!t) return '{}';

    const openBraces = (t.match(/{/g) || []).length - (t.match(/}/g) || []).length;
    const openBrackets = (t.match(/\[/g) || []).length - (t.match(/]/g) || []).length;

    // Remove trailing commas before } or ]
    t = t.replace(/,\s*([}\]])/g, '$1');

    if (openBrackets > 0) t += ']'.repeat(openBrackets);
    if (openBraces > 0) t += '}'.repeat(openBraces);
    return t;
  };

  const repairLooseJsonObject = (s: string): string => {
    let t = (s ?? '').trim();
    if (!t) return t;

    // 1) Remove trailing commas.
    t = t.replace(/,\s*([}\]])/g, '$1');

    // 2) Quote unquoted object keys.
    //    Example: { action: call_tool } -> { "action": call_tool }
    t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*?)\s*:/g, '$1"$2":');

    // 3) Convert single-quoted string values after colon to double quotes.
    t = t.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"');

    // 4) Quote bareword string values after colon.
    t = t.replace(/:\s*([A-Za-z_][A-Za-z0-9_-]*)(\s*[,\}])/g, (_m, val, tail) => {
      const lower = String(val).toLowerCase();
      if (lower === 'true' || lower === 'false' || lower === 'null') return `:${val}${tail}`;
      return `:"${val}"${tail}`;
    });

    // trailing commas pass again
    t = t.replace(/,\s*([}\]])/g, '$1');
    return t;
  };

  // 1) Direct JSON
  const direct = tryParse(input);
  if (direct !== null) return direct;

  // 2) JSON in markdown fences
  const fenceMatch = input.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const fromFence = tryParse(fenceMatch[1].trim());
    if (fromFence !== null) return fromFence;
  }

  // 3) Extract the first JSON-ish object/array from text.
  const braceStart = input.indexOf('{');
  const bracketStart = input.indexOf('[');

  let startIdx = -1;
  let endIdx = -1;
  if (braceStart !== -1 && (bracketStart === -1 || braceStart < bracketStart)) {
    startIdx = braceStart;
    // Find matching closing brace with nested depth, ignoring braces inside quoted strings.
    let depth = 0;
    let inString = false;
    let quoteChar = '';
    let escape = false;

    for (let i = startIdx; i < input.length; i++) {
      const ch = input[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === quoteChar) {
          inString = false;
          quoteChar = '';
        }
        continue;
      }

      // Enter a quoted string; LLM "loose JSON" often uses single quotes too.
      if (ch === '"' || ch === '\'') {
        inString = true;
        quoteChar = ch;
        continue;
      }

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    // If matching brace wasn't found (truncated), fall back to the last brace.
    if (endIdx === -1) endIdx = input.lastIndexOf('}');
  } else if (bracketStart !== -1) {
    startIdx = bracketStart;
    // Balanced extraction for arrays would be similar; for now use lastIndexOf
    // (arrays are uncommon in tool-plan outputs).
    endIdx = input.lastIndexOf(']');
  }

  if (startIdx === -1) return null;

  const content = endIdx > startIdx ? input.slice(startIdx, endIdx + 1) : input.slice(startIdx);

  // 4) Try parsing with repair candidates.
  const candidates = [content, repairTruncatedJson(content), repairLooseJsonObject(repairTruncatedJson(content))];
  for (const raw of candidates) {
    const parsed = tryParse(raw);
    if (parsed !== null) return parsed;
  }

  return null;
}

// Timeout for LLM-backed calls (interpreter, response-generator, teaching)
const LLM_TIMEOUT_MS = 300_000;
const SESSION_CLEANUP_MS = 600_000;
// Timeout for fast internal calls (graph-builder, logic-engine, memory)
const FAST_TIMEOUT_MS = 30_000;
// Observer chains graph-builder + logic-engine sequentially; must exceed per-hop service timeouts.
const OBSERVER_VALIDATE_TIMEOUT_MS = Number(process.env.OBSERVER_VALIDATE_TIMEOUT_MS) || 180_000;
// Max retries for transient failures (service restarting after crash)
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

/**
 * Axios call with timeout + retry. If a service crashes and Docker restarts it,
 * we retry after a short delay so the pipeline recovers instead of hanging.
 */
async function axiosWithRetry<T = any>(
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  dataOrConfig?: any,
  config?: any,
  options: { timeout?: number; retries?: number } = {},
): Promise<{ data: T }> {
  const timeout = options.timeout ?? FAST_TIMEOUT_MS;
  const maxRetries = options.retries ?? MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (method === 'get') {
        return await axios.get(url, { ...dataOrConfig, timeout });
      } else if (method === 'delete') {
        return await axios.delete(url, { ...dataOrConfig, timeout });
      } else if (method === 'patch') {
        return await axios.patch(url, dataOrConfig, { ...config, timeout });
      } else {
        return await axios.post(url, dataOrConfig, { ...config, timeout });
      }
    } catch (err: any) {
      const isRetryable =
        err.code === 'ECONNREFUSED' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.message?.includes('socket hang up') ||
        (err.response?.status && err.response.status >= 502 && err.response.status <= 504);

      if (isRetryable && attempt < maxRetries) {
        const delay = RETRY_DELAY_MS * (attempt + 1);
        // Service likely restarting — wait and retry
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`axiosWithRetry: unreachable`);
}

/** When not `false`, tool-plan requests get a Neo4j code-symbol summary from memory-service (requires code-indexer + index). */
const CODE_KNOWLEDGE_IN_TOOL_PLAN = process.env.OASIS_CODE_KNOWLEDGE_IN_TOOL_PLAN !== 'false';
const CODE_KNOWLEDGE_TIMEOUT_MS = Math.min(
  Number(process.env.OASIS_CODE_KNOWLEDGE_TIMEOUT_MS) || 2500,
  10000,
);

/**
 * Known directory-level scopes in the project — maps keywords/aliases to path prefixes.
 * When the user mentions "code graph" we know to scope to code_indexer + the UI panel, etc.
 */
const SCOPE_KEYWORD_TO_PATHS: Record<string, string[]> = {
  // Backend services
  'code_indexer':   ['services/code_indexer'],
  'code-indexer':   ['services/code_indexer'],
  'code indexer':   ['services/code_indexer'],
  'code graph':     ['services/code_indexer', 'apps/oasis-ui-react/src/components/graph', 'apps/api-gateway/src/code-graph'],
  'code-graph':     ['services/code_indexer', 'apps/oasis-ui-react/src/components/graph', 'apps/api-gateway/src/code-graph'],
  'interpreter':    ['services/interpreter'],
  'memory':         ['services/memory_service'],
  'memory-service': ['services/memory_service'],
  'memory_service': ['services/memory_service'],
  'dev-agent':      ['services/dev_agent', 'apps/api-gateway/src/dev-agent'],
  'dev_agent':      ['services/dev_agent', 'apps/api-gateway/src/dev-agent'],
  'tool-executor':  ['services/tool_executor'],
  'tool_executor':  ['services/tool_executor'],
  // Frontend
  'ui':             ['apps/oasis-ui-react/src'],
  'frontend':       ['apps/oasis-ui-react/src'],
  'react':          ['apps/oasis-ui-react/src'],
  'chat':           ['apps/oasis-ui-react/src/components/chat'],
  'timeline':       ['apps/oasis-ui-react/src/components/timeline'],
  'graph panel':    ['apps/oasis-ui-react/src/components/graph'],
  'diff viewer':    ['apps/oasis-ui-react/src/components/chat'],
  // Gateway
  'gateway':        ['apps/api-gateway/src'],
  'api-gateway':    ['apps/api-gateway/src'],
  'interaction':    ['apps/api-gateway/src/interaction'],
  'worktree':       ['apps/api-gateway/src/interaction', 'services/dev_agent'],
};

/**
 * Derive path-prefix scope hints from the semantic structure + user message.
 * Returns an array of path prefixes (may be empty = no scoping).
 */
function extractScopeHints(userMessage: string, semanticStructure: any): string[] {
  const prefixes = new Set<string>();
  const text = [
    userMessage,
    semanticStructure?.problem || '',
    semanticStructure?.trigger || '',
  ].join(' ').toLowerCase();

  // Check entities (both keys and values)
  const ents = semanticStructure?.entities;
  if (ents && typeof ents === 'object') {
    for (const [k, v] of Object.entries(ents)) {
      const combined = `${k} ${typeof v === 'string' ? v : ''}`.toLowerCase();
      for (const [keyword, paths] of Object.entries(SCOPE_KEYWORD_TO_PATHS)) {
        if (combined.includes(keyword)) {
          paths.forEach((p) => prefixes.add(p));
        }
      }
    }
  }

  // Check the user message + problem + trigger
  for (const [keyword, paths] of Object.entries(SCOPE_KEYWORD_TO_PATHS)) {
    if (text.includes(keyword)) {
      paths.forEach((p) => prefixes.add(p));
    }
  }

  // Also look for explicit file paths mentioned in the message
  for (const m of userMessage.matchAll(/(?:apps|services|packages)\/[a-zA-Z0-9_-]+/g)) {
    prefixes.add(m[0]);
  }

  return [...prefixes].slice(0, 6);
}

function extractCodeSearchQueries(userMessage: string, semanticStructure: any): string[] {
  const queries = new Set<string>();
  const push = (raw: string | undefined) => {
    const t = (raw || '').trim();
    if (t.length < 2 || t.length > 96) return;
    queries.add(t.slice(0, 96));
  };

  // Entities are the highest-signal source (interpreter extracted them)
  const ents = semanticStructure?.entities;
  if (ents && typeof ents === 'object' && !Array.isArray(ents)) {
    for (const [k, v] of Object.entries(ents)) {
      push(k);
      if (typeof v === 'string') push(v);
    }
  } else if (Array.isArray(ents)) {
    for (const e of ents) {
      if (typeof e === 'string') push(e);
      else if (e && typeof e === 'object' && typeof (e as any).name === 'string') push((e as any).name);
    }
  }

  // Problem field — but only if it's short and looks like a symbol/concept, not a full sentence
  const problem = typeof semanticStructure?.problem === 'string' ? semanticStructure.problem : '';
  if (problem.length > 0 && problem.length <= 60 && !problem.includes(' ')) {
    push(problem);
  }

  const text = typeof userMessage === 'string' ? userMessage : '';
  // PascalCase identifiers (likely component/class names)
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)) {
    push(m[0]);
    if (queries.size >= 5) break;
  }
  // snake_case / camelCase identifiers
  const stop = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'file', 'code', 'update', 'create', 'fix', 'add', 'remove',
    'please', 'make', 'change', 'using', 'into', 'when', 'what', 'your', 'have', 'need', 'want', 'currently', 'should',
    'also', 'like', 'just', 'only', 'then', 'because', 'about', 'which', 'every', 'single', 'time', 'available',
  ]);
  for (const m of text.matchAll(/\b[a-z][a-z0-9_]{3,}\b/g)) {
    const w = m[0].toLowerCase();
    if (stop.has(w)) continue;
    push(m[0]);
    if (queries.size >= 8) break;
  }

  if (queries.size === 0 && text.length > 3) {
    const w = text.split(/\s+/).find((x) => x.length > 4);
    if (w) push(w.replace(/[^a-zA-Z0-9_/-]/g, ''));
  }
  return [...queries].slice(0, 4);
}

/**
 * Best-effort: memory-service `/internal/memory/code/symbols` (same Neo4j as code-indexer).
 * Now scope-aware: uses semantic structure to derive path-prefix filters so only
 * symbols from the relevant module/feature area are returned.
 */
async function fetchCodeKnowledgeSummaryBlock(
  userMessage: string,
  semanticStructure: any,
): Promise<string> {
  if (!CODE_KNOWLEDGE_IN_TOOL_PLAN) return '';
  const queries = extractCodeSearchQueries(userMessage, semanticStructure);
  if (queries.length === 0) return '';

  const scopeHints = extractScopeHints(userMessage, semanticStructure);
  const pathPrefixParam = scopeHints.length > 0 ? scopeHints.join(',') : undefined;

  const slices = queries.slice(0, 3);

  // If we have scope hints, do a scoped search first; fall back to unscoped if no results
  const results = await Promise.all(
    slices.map(async (q) => {
      try {
        const params: Record<string, any> = { q, limit: 8 };
        if (pathPrefixParam) params.path_prefix = pathPrefixParam;

        const res = await axiosWithRetry<{ symbols?: any[] }>(
          'get',
          `${MEMORY_URL}/internal/memory/code/symbols`,
          { params },
          undefined,
          { timeout: CODE_KNOWLEDGE_TIMEOUT_MS, retries: 0 },
        );
        const syms = res.data?.symbols;

        // If scoped search returned nothing, try unscoped as fallback
        if ((!syms || syms.length === 0) && pathPrefixParam) {
          const fallbackRes = await axiosWithRetry<{ symbols?: any[] }>(
            'get',
            `${MEMORY_URL}/internal/memory/code/symbols`,
            { params: { q, limit: 8 } },
            undefined,
            { timeout: CODE_KNOWLEDGE_TIMEOUT_MS, retries: 0 },
          );
          return fallbackRes.data?.symbols;
        }

        return syms;
      } catch {
        return undefined;
      }
    }),
  );

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const syms of results) {
    if (!Array.isArray(syms)) continue;
    for (const s of syms) {
      const key = `${s.name}:${s.file_path}:${s.line_start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(
        `  - ${s.type || '?'} ${s.name} @ ${s.file_path || '?'}:${s.line_start ?? '?'}`,
      );
      if (lines.length >= 14) break;
    }
    if (lines.length >= 14) break;
  }
  if (lines.length === 0) return '';

  const scopeLabel = scopeHints.length > 0
    ? ` (scoped to: ${scopeHints.join(', ')})`
    : ' (global — no scope detected)';
  return (
    `[CODE INDEX (Neo4j)${scopeLabel} — indexed symbols; prefer read_file / read_worktree_file on these paths over blind grep]\n` +
    lines.join('\n') +
    '\n'
  );
}

// ── Artifact helpers ─────────────────────────────────────────────────

/** Search artifacts via RAG. Returns an array of {chunk_text, artifact_id, artifact_name, similarity, chunk_index}. */
async function fetchArtifactSearchResults(
  query: string,
  projectId?: string,
  limit = 5,
): Promise<Array<{ chunk_text: string; artifact_id: string; artifact_name: string; similarity: number; chunk_index?: number }>> {
  try {
    const params: Record<string, string | number> = { q: query, limit };
    if (projectId) params.project_id = projectId;
    const res = await axiosWithRetry(
      'get',
      `${ARTIFACT_URL}/internal/artifacts/search`,
      { params },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );
    return res.data?.results || [];
  } catch {
    return [];
  }
}

/** Fetch a single artifact by ID (full metadata including transcript and summary). */
async function fetchArtifactById(
  artifactId: string,
): Promise<Record<string, any> | null> {
  try {
    const res = await axiosWithRetry(
      'get',
      `${ARTIFACT_URL}/internal/artifacts/${artifactId}`,
      undefined,
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );
    return res.data || null;
  } catch {
    return null;
  }
}

/** Resolve mentioned artifact IDs into context strings (name + transcript/summary, truncated). */
async function resolveArtifactMentions(
  artifactIds: string[],
): Promise<string> {
  if (!artifactIds || artifactIds.length === 0) return '';
  const MAX_PER_ARTIFACT = 2000;
  const parts: string[] = [];
  await Promise.all(
    artifactIds.map(async (id) => {
      try {
        const res = await axiosWithRetry(
          'get',
          `${ARTIFACT_URL}/internal/artifacts/${id}`,
          undefined,
          undefined,
          { timeout: FAST_TIMEOUT_MS, retries: 1 },
        );
        const artifact = res.data;
        const name = artifact?.name || id;
        const content = artifact?.transcript || artifact?.summary || '';
        const truncated = content.length > MAX_PER_ARTIFACT
          ? content.slice(0, MAX_PER_ARTIFACT) + '... [truncated]'
          : content;
        if (truncated) {
          parts.push(`[${name}]: ${truncated}`);
        }
      } catch {
        // skip unavailable artifacts
      }
    }),
  );
  return parts.join('\n\n');
}

@Injectable()
export class InteractionService {
  private readonly logger = new Logger(InteractionService.name);
  // Track worktree_id per session for auto-routing read_file to read_worktree_file
  private sessionWorktrees: Map<string, string> = new Map();

  constructor(
    private readonly events: RedisEventService,
    private readonly langfuse: LangfuseService,
    private readonly sessionConfig: SessionConfigService,
  ) {}

  private _getSessionWorktreeId(sessionId: string): string | undefined {
    return this.sessionWorktrees.get(sessionId);
  }

  private _setSessionWorktreeId(sessionId: string, worktreeId: string): void {
    this.sessionWorktrees.set(sessionId, worktreeId);
  }

  async execute(req: InteractionRequest, isAborted: () => boolean = () => false): Promise<InteractionResponse> {
    const sessionId = req.session_id || uuidv4();
    const interactionId = uuidv4();
    const clientMessageId = req.context?.client_message_id;

    // When reply_to is present, build the formatted prompt for the LLM
    const replyTo = req.context?.reply_to as { message_id?: string; preview?: string } | undefined;
    if (replyTo?.preview != null && req.user_message) {
      const preview = String(replyTo.preview).length > 150 ? String(replyTo.preview).slice(0, 150) + '…' : String(replyTo.preview);
      req.user_message = `[Feedback on your previous response]\n\n"${preview}"\n\nUser feedback: ${req.user_message}`;
    }

    // Store user message in conversation history
    await this.events.pushMessage(sessionId, 'user', req.user_message);

    // Fetch recent conversation history for LLM context
    const recentMessages = await this.events.getRecentMessages(sessionId, 20);
    // Exclude the current message (last one) — it'll be passed separately
    let chatHistory = recentMessages.slice(0, -1);
    // Condense if over 50% of context window
    chatHistory = await condenseChatHistoryIfNeeded(chatHistory);
    if (chatHistory.length > 0) {
      this.logger.log(`LLM context: ${chatHistory.length} prior chat turn(s) for session ${sessionId}`);
    }

    const trace = this.langfuse.createTrace({
      name: 'oasis-reasoning-pipeline',
      sessionId,
      input: { user_message: req.user_message, context: req.context },
      metadata: { source: req.context?.source || 'api' },
    });

    try {
      await this.events.publish('InteractionReceived', sessionId, {
        user_message: req.user_message,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });

      // ── Step 0: Resume pending teaching (multi-turn) if present ───────
      const pending = await this.getPendingTeaching(sessionId);
      if (pending) {
        this.logger.log(`Pending teaching found for session ${sessionId}, resuming...`);
        return this.handleTeachingFollowup(sessionId, req, pending, trace, interactionId, clientMessageId);
      }

      // ── Step 1: Interpret (always runs) ──────────────────────────────
      this.logger.log('Calling interpreter service...');
      const interpretSpan = trace?.span({ name: 'interpreter', input: { text: req.user_message } });
      const llmStart = Date.now();
      await this.events.publish('LlmCallStarted', sessionId, {
        service: 'interpreter',
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });
      const interpretRes = await axiosWithRetry('post', `${INTERPRETER_URL}/internal/interpret`, {
        text: req.user_message,
        context: req.context || {},
        chat_history: chatHistory.length > 0 ? buildInterpreterChatHistory(chatHistory) : undefined,
      }, undefined, { timeout: LLM_TIMEOUT_MS });
      await this.events.publish('LlmCallCompleted', sessionId, {
        service: 'interpreter',
        duration_ms: Date.now() - llmStart,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });
      const semanticStructure = interpretRes.data.semantic_structure;
      let route = semanticStructure.route || 'complex';
      interpretSpan?.end({ output: { ...semanticStructure, route } });

      // ── Route correction: if the previous turn was tool_use and this message is a
      // short imperative follow-up (likely "continue", "do it", "fix that too"), override
      // casual → tool_use.  But leave "complex" alone — follow-up questions asking for
      // opinions, suggestions, or analysis should stay in the complex pipeline where chat
      // history + knowledge graph provide the answer, not the tool-use loop.
      if (route === 'casual') {
        const prevAssistantTurn = chatHistory.filter(t => t.role === 'assistant').slice(-1)[0];
        const msgText = (req.user_message || '').trim();
        const msgLen = msgText.length;
        // Only override very short imperative follow-ups (not questions)
        const looksLikeQuestion = /\?|suggest|would you|should|what|how|why|any other|anything extra/i.test(msgText);
        // Check if previous assistant message looks like a tool_use response
        const prevLooksLikeToolUse = prevAssistantTurn?.content &&
          (/Tool calls:|```|worktree|applied patch|diff|created file|edited file/i.test(prevAssistantTurn.content) ||
           !!this._getSessionWorktreeId(sessionId));
        if (prevLooksLikeToolUse && msgLen < 60 && !looksLikeQuestion) {
          this.logger.warn(
            `Route override: ${route} → tool_use (previous turn was tool_use, current message is short imperative: "${msgText.slice(0, 40)}")`,
          );
          route = 'tool_use';
          semanticStructure.route = 'tool_use';
        }
      }

      await this.events.publish('SemanticParsed', sessionId, { ...semanticStructure, route, interaction_id: interactionId, client_message_id: clientMessageId });
      this.logger.log(`Route classified: ${route}`);

      // ── Step 2: Route-based dispatch ─────────────────────────────────
      let result: InteractionResponse;
      switch (route) {
        case 'casual':
          result = await this.handleCasual(sessionId, req, semanticStructure, trace, interactionId, clientMessageId, chatHistory);
          break;
        case 'teaching':
          result = await this.handleTeaching(sessionId, req, semanticStructure, trace, interactionId, clientMessageId);
          break;
        case 'tool_use':
          result = await this.handleToolUse(sessionId, req, semanticStructure, trace, interactionId, clientMessageId, chatHistory, isAborted);
          break;
        case 'complex':
        default:
          result = await this.handleComplex(sessionId, req, semanticStructure, trace, interactionId, clientMessageId, chatHistory);
          break;
      }

      // Store assistant response in conversation history
      if (result.response) {
        await this.events.pushMessage(sessionId, 'assistant', result.response);
      }

      return result;
    } catch (err: any) {
      this.logger.error(`Pipeline failed: ${err.message}`);
      trace?.update({ output: { error: err.message } });
      const detail = err.response?.data || err.message;

      // Emit a PipelineFailed event so the timeline shows the error
      await this.events.publish('PipelineFailed', sessionId, {
        error: err.message,
        detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });

      throw new HttpException(
        { error: 'Reasoning pipeline failed', detail },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async getPendingTeaching(sessionId: string): Promise<any | null> {
    try {
      const res = await axiosWithRetry('get', `${MEMORY_URL}/internal/memory/teaching/pending`, {
        params: { session_id: sessionId },
      }, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 });
      return res.data?.pending || null;
    } catch {
      return null;
    }
  }

  private async clearPendingTeaching(sessionId: string): Promise<void> {
    try {
      await axiosWithRetry('delete', `${MEMORY_URL}/internal/memory/teaching/pending`, {
        params: { session_id: sessionId },
      }, undefined, { timeout: FAST_TIMEOUT_MS, retries: 0 });
    } catch {
      // optional
    }
  }

  // ── CASUAL: simple LLM chat, no reasoning ────────────────────────────
  private async handleCasual(
    sessionId: string,
    req: InteractionRequest,
    _semanticStructure: any,
    trace: any,
    _interactionId: string,
    _clientMessageId: string | undefined,
    chatHistory: Array<{ role: string; content: string }> = [],
  ): Promise<InteractionResponse> {
    this.logger.log('Casual route — direct LLM chat');
    const chatSpan = trace?.span({ name: 'casual-chat', input: { text: req.user_message } });

    // Fetch memory (Knowledge Graph), rules, and artifact search in parallel
    let memoryContext: any[] = [];
    let rules: any[] = [];
    let memoryStaleHint: string | undefined;
    let artifactSearchResults: Array<{ chunk_text: string; artifact_name: string; similarity: number }> = [];
    let artifactContext = '';
    try {
      const projectId = req.context?.project_id;
      const mentionedIds: string[] = req.context?.mentioned_artifact_ids || [];
      const [memRes, rulesRes, artSearchRes, artMentions] = await Promise.all([
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/query`, {
          params: { q: req.user_message, limit: 5, session_id: sessionId },
        }, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 }),
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, undefined, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 }),
        fetchArtifactSearchResults(req.user_message, projectId, 5),
        resolveArtifactMentions(mentionedIds),
      ]);
      memoryContext = memRes.data.results || [];
      rules = rulesRes.data.rules || [];
      memoryStaleHint = memRes.data.stale_count > 0 ? memRes.data.stale_hint : undefined;
      artifactSearchResults = artSearchRes;
      artifactContext = artMentions;
    } catch {
      // memory, rules, and artifacts are optional
    }

    const llmStart = Date.now();
    await this.events.publish('LlmCallStarted', sessionId, {
      service: 'response-generator',
      route: 'casual',
      interaction_id: _interactionId,
      client_message_id: _clientMessageId,
    });
    const chatContext = {
      ...(req.context || {}),
      rules: rules.length > 0 ? rules : undefined,
      memory_context: memoryContext.length > 0 ? memoryContext : undefined,
      memory_stale_hint: memoryStaleHint,
      artifact_search_results: artifactSearchResults.length > 0 ? artifactSearchResults : undefined,
      artifact_context: artifactContext || undefined,
    };
    const chatRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/response/chat`, {
      user_message: req.user_message,
      context: chatContext,
      chat_history: chatHistory.length > 0 ? chatHistory : undefined,
    }, undefined, { timeout: LLM_TIMEOUT_MS });
    await this.events.publish('LlmCallCompleted', sessionId, {
      service: 'response-generator',
      route: 'casual',
      duration_ms: Date.now() - llmStart,
      interaction_id: _interactionId,
      client_message_id: _clientMessageId,
    });
    const responseText = chatRes.data.response_text;
    chatSpan?.end({ output: { response_length: responseText.length } });

    await this.events.publish('ResponseGenerated', sessionId, {
      response_length: responseText.length,
      interaction_id: _interactionId,
      client_message_id: _clientMessageId,
    });

    trace?.update({ output: { response: responseText, route: 'casual' } });

    return {
      session_id: sessionId,
      response: responseText,
      reasoning_graph: {},
      confidence: 1.0,
      reasoning_trace: ['Route: casual — direct chat response'],
      route: 'casual',
    };
  }

  // ── COMPLEX: full reasoning pipeline (any domain) ────────────────────
  private async handleComplex(
    sessionId: string,
    req: InteractionRequest,
    semanticStructure: any,
    trace: any,
    interactionId: string,
    clientMessageId: string | undefined,
    chatHistory: Array<{ role: string; content: string }> = [],
  ): Promise<InteractionResponse> {
    this.logger.log('Complex route — full reasoning pipeline');

    // 1. Build reasoning graph
    const graphSpan = trace?.span({ name: 'graph-builder', input: { semantic_structure: semanticStructure } });
    const graphRes = await axiosWithRetry('post', `${GRAPH_BUILDER_URL}/internal/graph/build`, {
      semantic_structure: semanticStructure,
      session_id: sessionId,
    }, undefined, { timeout: FAST_TIMEOUT_MS });
    const reasoningGraph = graphRes.data.reasoning_graph;
    graphSpan?.end({ output: { graph_id: reasoningGraph.id, node_count: reasoningGraph.nodes?.length || 0 } });

    await this.events.publish('GraphConstructed', sessionId, {
      graph_id: reasoningGraph.id,
      node_count: reasoningGraph.nodes?.length || 0,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });

    // 2. Retrieve memory context, rules, and artifact search in parallel
    const memorySpan = trace?.span({ name: 'memory-query' });
    let memoryContext: any[] = [];
    let memoryStaleHint: string | undefined;
    let rules: any[] = [];
    let artifactSearchResults: Array<{ chunk_text: string; artifact_name: string; similarity: number }> = [];
    let artifactContext = '';
    try {
      const problemTitle = semanticStructure.problem || req.user_message;
      const projectId = req.context?.project_id;
      const mentionedIds: string[] = req.context?.mentioned_artifact_ids || [];
      const [memRes, foundationalRes, rulesRes, artSearchRes, artMentions] = await Promise.all([
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/query`, {
          params: { q: problemTitle, limit: 5, session_id: sessionId },
        }, undefined, { timeout: FAST_TIMEOUT_MS }),
        // Also fetch foundational graph nodes for grounded reasoning
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/nodes-by-tier`, {
          params: { tier: 'foundational', session_id: sessionId, limit: 10 },
        }, undefined, { timeout: FAST_TIMEOUT_MS }).catch(() => ({ data: { nodes: [] } })),
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, undefined, undefined, { timeout: FAST_TIMEOUT_MS }),
        fetchArtifactSearchResults(req.user_message, projectId, 5),
        resolveArtifactMentions(mentionedIds),
      ]);
      memoryContext = memRes.data.results || [];
      // Merge foundational graph nodes into memory context so they are always available
      const foundationalNodes = (foundationalRes.data.nodes || []).map((n: any) => ({
        type: 'foundational_node',
        node_type: n.node_type,
        title: n.title,
        description: n.description,
        confidence: n.confidence,
      }));
      if (foundationalNodes.length > 0) {
        memoryContext = [...foundationalNodes, ...memoryContext];
      }
      memoryStaleHint = memRes.data.stale_count > 0 ? memRes.data.stale_hint : undefined;
      rules = rulesRes.data.rules || [];
      artifactSearchResults = artSearchRes;
      artifactContext = artMentions;
      memorySpan?.end({ output: { result_count: memoryContext.length, foundational_count: foundationalNodes.length, stale: !!memoryStaleHint } });

      // Inject artifact nodes into the reasoning graph (Knowledge Base tier)
      if (artifactSearchResults.length > 0 && reasoningGraph?.nodes) {
        if (!reasoningGraph.edges) reasoningGraph.edges = [];
        const seen = new Set<string>();
        for (const art of artifactSearchResults) {
          const name = art.artifact_name || 'unknown';
          if (seen.has(name)) continue;
          seen.add(name);
          const artNodeId = `artifact-${name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)}`;
          reasoningGraph.nodes.push({
            id: artNodeId,
            node_type: 'ArtifactNode',
            tier: 'foundational',
            title: name.slice(0, 60),
            description: (art.chunk_text || '').slice(0, 200),
            source: 'system',
            confidence: art.similarity ?? 1.0,
            attributes: { artifact_name: name, similarity: art.similarity },
          });
          const problemNode = reasoningGraph.nodes.find((n: any) => n.node_type === 'ProblemNode');
          if (problemNode) {
            reasoningGraph.edges.push({
              source_node: artNodeId,
              target_node: problemNode.id,
              edge_type: 'SUPPORTS',
            });
          }
        }
        this.logger.log(`Added ${seen.size} artifact node(s) to reasoning graph`);
      }
    } catch {
      this.logger.warn('Memory/rules/artifact retrieval partially failed, continuing with available context');
      memorySpan?.end({ output: { error: 'partial_failure' } });
    }

    // 3. Logic engine reasoning (with memory + rules context; reduce reliance if stale)
    const reasonSpan = trace?.span({ name: 'logic-engine', input: { node_count: reasoningGraph.nodes?.length || 0, memory_count: memoryContext.length, rules_count: rules.length } });
    const reasonRes = await axiosWithRetry('post', `${LOGIC_ENGINE_URL}/internal/reason`, {
      reasoning_graph: reasoningGraph,
      memory_context: [...memoryContext, ...rules.map((r: any) => ({ type: 'rule', ...r }))],
      memory_stale_hint: memoryStaleHint,
    }, undefined, { timeout: FAST_TIMEOUT_MS });
    const decisionTree = reasonRes.data.decision_tree;
    const confidence = reasonRes.data.confidence;
    reasonSpan?.end({ output: { conclusion: decisionTree.conclusion, confidence } });

    await this.events.publish('DecisionFinalized', sessionId, {
      decision: decisionTree.conclusion,
      confidence,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });

    // 5. Generate natural language response (tolerate LLM / response-generator failures)
    let responseText = '';
    try {
      const responseSpan = trace?.span({ name: 'response-generator', input: { conclusion: decisionTree.conclusion } });
      const llmStart = Date.now();
      await this.events.publish('LlmCallStarted', sessionId, {
        service: 'response-generator',
        route: 'complex',
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });
      const responseContext = {
        ...(req.context || {}),
        intent: semanticStructure.intent || 'diagnose',
        memory_stale_hint: memoryStaleHint,
        artifact_search_results: artifactSearchResults.length > 0 ? artifactSearchResults : undefined,
        artifact_context: artifactContext || undefined,
      };
      responseText = await this.generateStreamingResponse(
        sessionId,
        interactionId,
        clientMessageId,
        {
          decision_tree: decisionTree,
          user_message: req.user_message,
          context: responseContext,
          chat_history: chatHistory.length > 0 ? chatHistory : undefined,
        },
        '/internal/response/generate-stream'
      );
      responseSpan?.end({ output: { response_length: responseText.length } });

      await this.events.publish('LlmCallCompleted', sessionId, {
        service: 'response-generator',
        route: 'complex',
        duration_ms: Date.now() - llmStart,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });

      await this.events.publish('ResponseGenerated', sessionId, {
        response_length: responseText.length,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });
    } catch (err: any) {
      // If response generation fails (e.g., Ollama EOF / model crash), fall back to a simple
      // message derived from the decision tree instead of failing the whole pipeline.
      this.logger.warn(`Response generator failed, falling back to simple message: ${err?.message || err}`);
      responseText = decisionTree.conclusion || 'I reached a conclusion but could not generate a detailed explanation.';
    }

    // 6. Store reasoning graph in memory
    try {
      const storeSpan = trace?.span({ name: 'memory-store' });
      await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/store`, {
        reasoning_graph: decisionTree.graph || reasoningGraph,
        user_id: 'default',
      }, undefined, { timeout: FAST_TIMEOUT_MS });
      storeSpan?.end({ output: { graph_id: reasoningGraph.id } });
      await this.events.publish('MemoryUpdated', sessionId, {
        graph_id: reasoningGraph.id,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });
    } catch {
      this.logger.warn('Failed to store in memory, continuing');
    }

    trace?.update({ output: { response: responseText, confidence, route: 'complex' } });

    return {
      session_id: sessionId,
      response: responseText,
      reasoning_graph: decisionTree.graph || reasoningGraph,
      confidence,
      reasoning_trace: decisionTree.reasoning_trace || [],
      conclusion: decisionTree.conclusion,
      route: 'complex',
    };
  }

  // ── TOOL USE: multi-agent loop — Plan → Execute → Observer validate → repeat ────
  private async handleToolUse(
    sessionId: string,
    req: InteractionRequest,
    semanticStructure: any,
    trace: any,
    interactionId: string,
    clientMessageId: string | undefined,
    chatHistory: Array<{ role: string; content: string }> = [],
    isAborted: () => boolean = () => false,
  ): Promise<InteractionResponse> {
    this.logger.log('Tool-use route — multi-agent loop (Plan → Execute → Observer)');
    const toolSpan = trace?.span({ name: 'tool-use', input: { text: req.user_message } });

    const sessionCfg = this.sessionConfig.getConfig(sessionId, req.context);
    const autonomousMode = sessionCfg.autonomous_mode;
    const maxDurationMs = sessionCfg.autonomous_max_duration_hours * 3600 * 1000;
    const maxIterations = autonomousMode ? 10000 : MAX_TOOL_ITERATIONS;
    const loopStartTime = Date.now();

    // ── Auto-discover existing worktree for this session ─────────────
    // If the session doesn't have a worktree set (e.g. follow-up message after restart),
    // query the dev-agent for active worktrees and pick one up automatically.
    if (!this._getSessionWorktreeId(sessionId)) {
      try {
        const wtRes = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/worktrees`, { timeout: 5000 });
        const worktrees: Array<{ id: string; branch?: string }> = wtRes.data?.worktrees || [];
        if (worktrees.length > 0) {
          // Use the most recent worktree (last in list)
          const wt = worktrees[worktrees.length - 1];
          this._setSessionWorktreeId(sessionId, wt.id);
          this.logger.log(`Auto-discovered existing worktree for session ${sessionId}: ${wt.id}`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to query existing worktrees: ${err.message}`);
      }
    }

    // ── Pre-Phase: Free Thoughts (Free-form reasoning) ─────────────
    let freeThoughts = await this.generateStreamingThoughts(
      sessionId,
      req.user_message,
      req.context,
      chatHistory,
      interactionId,
      clientMessageId,
    );

    let consecutiveNeedInfo = 0;

    // ── Pre-Phase: Decision Layer (Think → Decide → Act) ─────────────
    const decisionStartTime = Date.now();
    const decisionRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/decision`, {
      thoughts: freeThoughts,
      user_message: req.user_message,
      context: { ...req.context, interactionId },
    }, undefined, { timeout: LLM_TIMEOUT_MS });
    
    let decision = decisionRes.data.decision;
    const timeToDecision = Date.now() - decisionStartTime;
    const timeToAction = Date.now() - loopStartTime;
    
    // Structured logging for metrics
    this.logger.log(`[DECISION_LOG] decision_type=${decision} thought_count=1 time_to_decision_ms=${timeToDecision} time_to_action_ms=${timeToAction}`);
    this.logger.log(`Decision Layer [pre-loop]: ${decision} (in ${timeToDecision}ms)`);

    if (decision === 'NEED_MORE_INFO') {
      consecutiveNeedInfo++;
      if (consecutiveNeedInfo >= 2) {
        this.logger.warn(`Overthinking Recovery [pre-loop]: Forced ACT after ${consecutiveNeedInfo} consecutive NEED_MORE_INFO.`);
        decision = 'ACT';
      }
    } else {
      consecutiveNeedInfo = 0;
    }

    await this.events.publish('DecisionLayerGenerated', sessionId, {
      decision,
      reason: decisionRes.data.reason,
      confidence: decisionRes.data.confidence,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
      forced: consecutiveNeedInfo >= 2,
    });

    if (decision === 'ANSWER_DIRECTLY') {
      this.logger.log('Decision: ANSWER_DIRECTLY — bypassing tool loop');
      const chatRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/response/chat`, {
        user_message: req.user_message,
        context: { ...(req.context || {}), thoughts: freeThoughts },
        chat_history: chatHistory.length > 0 ? chatHistory : undefined,
      }, undefined, { timeout: LLM_TIMEOUT_MS });
      const responseText =
        typeof chatRes.data.response_text === 'string' && chatRes.data.response_text.trim()
          ? chatRes.data.response_text.trim()
          : 'I did not get a text reply from the model. Please try rephrasing or check the reasoning timeline.';
      
      await this.events.publish('ResponseGenerated', sessionId, {
        response_length: responseText.length,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });

      return {
        session_id: sessionId,
        response: responseText,
        reasoning_graph: {},
        confidence: 1.0,
        reasoning_trace: [`Route: tool_use (Decision: ${decision})`, freeThoughts].filter(Boolean),
        route: 'tool_use',
      };
    }

    if (decision === 'NEED_MORE_INFO') {
      this.logger.log('Decision: NEED_MORE_INFO — requesting clarification');
      const question = decisionRes.data.reason || "I need more information before I can act.";
      const options: string[] = Array.isArray(decisionRes.data.options) ? decisionRes.data.options : [];
      // Format with clickable options if available
      let responseText = `🤔 **I need more info:** ${question}`;
      if (options.length > 0) {
        responseText += '\n\n' + options.map(o => `- ${o}`).join('\n');
      }
      return {
        session_id: sessionId,
        response: responseText,
        reasoning_graph: {},
        confidence: decisionRes.data.confidence || 0.5,
        reasoning_trace: [`Route: tool_use (Decision: ${decision})`, freeThoughts].filter(Boolean),
        route: 'tool_use',
      };
    }

    // ── Retrieve memory (Knowledge Graph), rules, and project artifacts — scope-filtered by semantic context ──
    const scopeHints = extractScopeHints(req.user_message, semanticStructure);
    let memoryContext: any[] = [];
    let rules: any[] = [];
    let memoryStaleHint: string | undefined;
    let artifactSearchResults: Array<{ chunk_text: string; artifact_name: string; similarity: number }> = [];
    let artifactContext = '';
    try {
      const problemTitle = semanticStructure?.problem || req.user_message;
      // Build a scope-enriched query: problem title + scope keywords for better memory retrieval
      const scopeKeywords = scopeHints.length > 0
        ? scopeHints.map((p) => p.split('/').pop()).filter(Boolean).join(' ')
        : '';
      const memoryQuery = scopeKeywords
        ? `${problemTitle} ${scopeKeywords}`.slice(0, 200)
        : problemTitle;

      // For rules: pass scope-derived keywords so only relevant rules are returned
      const rulesParams: Record<string, any> = {};
      if (scopeHints.length > 0) {
        // Extract meaningful keywords from scope paths (e.g. 'code_indexer', 'interaction', 'chat')
        const ruleKeywords = scopeHints
          .flatMap((p) => p.split('/'))
          .filter((seg) => seg.length > 2 && !['src', 'apps', 'services', 'components', 'packages'].includes(seg))
          .slice(0, 6);
        if (ruleKeywords.length > 0) {
          rulesParams.keywords = ruleKeywords.join(',');
        }
      }

      const projectId = req.context?.project_id;
      const mentionedIds: string[] = req.context?.mentioned_artifact_ids || [];
      const [memRes, foundationalRes, rulesRes, artSearchRes, artMentions] = await Promise.all([
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/query`, {
          params: { q: memoryQuery, limit: 5, session_id: sessionId },
        }, undefined, { timeout: FAST_TIMEOUT_MS }),
        // Fetch foundational graph nodes — these should always inform tool-use planning
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/nodes-by-tier`, {
          params: { tier: 'foundational', session_id: sessionId, limit: 10 },
        }, undefined, { timeout: FAST_TIMEOUT_MS }).catch(() => ({ data: { nodes: [] } })),
        axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, {
          params: rulesParams,
        }, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 }),
        // Fetch project artifacts via RAG search so tool-use planning has artifact context
        fetchArtifactSearchResults(req.user_message, projectId, 5),
        resolveArtifactMentions(mentionedIds),
      ]);
      memoryContext = memRes.data.results || [];
      const foundationalNodes = (foundationalRes.data.nodes || []).map((n: any) => ({
        type: 'foundational_node',
        node_type: n.node_type,
        title: n.title,
        description: n.description,
        confidence: n.confidence,
      }));
      if (foundationalNodes.length > 0) {
        memoryContext = [...foundationalNodes, ...memoryContext];
        this.logger.log(`Injected ${foundationalNodes.length} foundational graph node(s) into tool-use context`);
      }
      artifactSearchResults = artSearchRes;
      artifactContext = artMentions;
      if (artifactSearchResults.length > 0) {
        this.logger.log(`Injected ${artifactSearchResults.length} artifact search result(s) into tool-use context`);
      }
      rules = rulesRes.data.rules || [];
      memoryStaleHint = memRes.data.stale_count > 0 ? memRes.data.stale_hint : undefined;

      if (scopeHints.length > 0) {
        this.logger.log(
          `Scope-filtered context: ${scopeHints.join(', ')} → ${memoryContext.length} memories, ${rules.length} rules`,
        );
      }
    } catch {
      // memory and rules are optional
    }

    // ── Phase 1: Planning Agent (upfront plan) — with memory + rules ─────────────────
    await this.events.publish('ToolPlanningStarted', sessionId, {
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });

    let upfrontPlan: { steps: any[]; success_criteria: string[] } = { steps: [], success_criteria: [] };
    let taskGraph: Record<string, any> | null = null;

    try {
      const planRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/plan/tool-use`, {
        user_message: req.user_message,
        semantic_structure: semanticStructure,
        memory_context: memoryContext,
        rules,
        memory_stale_hint: memoryStaleHint,
        free_thoughts: freeThoughts,
        // Artifacts are no longer auto-injected; the LLM uses search_artifacts tool
      }, undefined, { timeout: LLM_TIMEOUT_MS });
      upfrontPlan = {
        steps: planRes.data.steps || [],
        success_criteria: planRes.data.success_criteria || [],
      };
      this.logger.log(`Upfront plan: ${upfrontPlan.steps.length} steps`);

      // Publish plan so UI can show PlanCard
      await this.events.publish('ToolPlanReady', sessionId, {
        steps: upfrontPlan.steps,
        success_criteria: upfrontPlan.success_criteria,
        plan_revision: 0,
        plan_revised: false,
        interaction_id: interactionId,
        client_message_id: clientMessageId,
      });

      // Build initial task graph via graph-builder
      const graphRes = await axiosWithRetry('post', `${GRAPH_BUILDER_URL}/internal/graph/build-task`, {
        semantic_structure: semanticStructure || {},
        plan_steps: upfrontPlan.steps,
        session_id: sessionId,
      }, undefined, { timeout: FAST_TIMEOUT_MS });
      taskGraph = graphRes.data.task_graph || null;

      // Inject artifact nodes into the task graph (Knowledge Base tier)
      if (taskGraph && artifactSearchResults.length > 0) {
        if (!taskGraph.nodes) taskGraph.nodes = [];
        if (!taskGraph.edges) taskGraph.edges = [];
        const seen = new Set<string>();
        for (const art of artifactSearchResults) {
          const name = art.artifact_name || 'unknown';
          if (seen.has(name)) continue;
          seen.add(name);
          const artNodeId = `artifact-${name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)}`;
          taskGraph.nodes.push({
            id: artNodeId,
            node_type: 'ArtifactNode',
            tier: 'foundational',
            title: name.slice(0, 60),
            description: (art.chunk_text || '').slice(0, 200),
            source: 'system',
            confidence: art.similarity ?? 1.0,
            attributes: { artifact_name: name, similarity: art.similarity },
          });
          // Link artifact to the goal node
          const goalNode = taskGraph.nodes.find((n: any) => n.node_type === 'GoalNode');
          if (goalNode) {
            taskGraph.edges.push({
              source_node: artNodeId,
              target_node: goalNode.id,
              edge_type: 'INFORMS',
            });
          }
        }
        this.logger.log(`Added ${seen.size} artifact node(s) to task graph`);
      }
    } catch (err: any) {
      this.logger.warn(`Planning or graph build failed: ${err.message} — continuing without plan`);
    }

    const toolResults: Array<{
      tool: string;
      command?: string;
      path?: string;
      pattern?: string;
      url?: string;
      success: boolean;
      output: string;
      blocked: boolean;
      reasoning?: string;
      worktree_id?: string;
      read_metadata?: ReadFileMetadata;
      start_line?: number;
      end_line?: number;
      recursive?: boolean;
    }> = [];
    let observerFeedback: string | null = null;
    let validatedThoughts: any[] = [];
    const wallsHit: string[] = [];
    let consecutiveFailures = 0;
    let consecutiveDuplicates = 0;
    let teachingForced = false;
    // Counts consecutive iterations where the loop produced no new tool-results
    // (e.g. repeated "final_answer" proposals rejected by Observer).
    let thoughtsOnlyStreak = 0;
    const explorationState: ExplorationState = {
      stagnation: 0,
      distinctRoots: new Set<string>(),
      exploratoryActionCount: 0,
    };
    let explorationEpisodeBroadenSent = false;
    let explorationEpisodeImplementSent = false;
    /** Loop iteration index when the current upfront plan was adopted (revisions reset step alignment). */
    let planStartIteration = 0;
    /** Increments each time the Observer triggers a full plan replan (UI + tool events tag this epoch). */
    let planRevision = 0;

    const runObserverReplan = async (feedbackForPlanner: string, atIteration: number): Promise<boolean> => {
      try {
        const planRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/plan/tool-use`, {
          user_message: req.user_message,
          semantic_structure: semanticStructure,
          memory_context: memoryContext,
          rules,
          memory_stale_hint: memoryStaleHint,
          free_thoughts: freeThoughts || undefined,
          observer_feedback: feedbackForPlanner,
          previous_plan: upfrontPlan.steps.length > 0 ? upfrontPlan : undefined,
          replan_after_observer: true,
        }, undefined, { timeout: LLM_TIMEOUT_MS });
        upfrontPlan = {
          steps: planRes.data.steps || [],
          success_criteria: planRes.data.success_criteria || [],
        };
        planRevision += 1;
        planStartIteration = atIteration + 1;
        await this.events.publish('ToolPlanReady', sessionId, {
          steps: upfrontPlan.steps,
          success_criteria: upfrontPlan.success_criteria,
          plan_revision: planRevision,
          plan_revised: true,
          revision_reason: feedbackForPlanner.slice(0, 500),
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });
        try {
          const graphRes = await axiosWithRetry('post', `${GRAPH_BUILDER_URL}/internal/graph/build-task`, {
            semantic_structure: semanticStructure || {},
            plan_steps: upfrontPlan.steps,
            session_id: sessionId,
            existing_graph: taskGraph && Object.keys(taskGraph).length > 0 ? taskGraph : undefined,
          }, undefined, { timeout: FAST_TIMEOUT_MS });
          if (graphRes.data?.task_graph) {
            taskGraph = graphRes.data.task_graph;
          }
        } catch (gErr: any) {
          this.logger.warn(`Graph rebuild after plan revision failed: ${gErr.message}`);
        }
        this.logger.log(
          `Plan revised to revision ${planRevision}; step alignment resets at loop iteration ${planStartIteration}`,
        );
        return true;
      } catch (e: any) {
        this.logger.warn(`Observer-triggered replan failed: ${e.message}`);
        return false;
      }
    };

    // ── Feasibility pre-check: skip in autonomous mode (agent teaches itself) ──
    if (!autonomousMode) {
    try {
      const wallsFromMemory = (memoryContext || []).flatMap((m: any) => m?.content?.walls || []);
      const feasRes = await axiosWithRetry('post', `${LOGIC_ENGINE_URL}/internal/assess-feasibility`, {
        user_goal: semanticStructure?.problem || req.user_message,
        memory_context: memoryContext,
        walls: wallsFromMemory,
      }, undefined, { timeout: FAST_TIMEOUT_MS });
      if (feasRes.data?.achievable === false) {
        const reason = feasRes.data.reason || 'Task marked as not achievable.';
        const suggestion = feasRes.data.suggestion || 'Try a different approach.';
        await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/store-not-achievable`, {
          goal: semanticStructure?.problem || req.user_message,
          reason,
          suggestion,
          session_id: sessionId,
        }, undefined, { timeout: FAST_TIMEOUT_MS }).catch(() => {});
        toolSpan?.end({ output: { feasibility: 'not_achievable' } });
        trace?.update({ output: { response: `This task appears not achievable: ${reason}. ${suggestion}`, route: 'tool_use' } });
        return {
          session_id: sessionId,
          response: `This task appears not achievable: ${reason}\n\nSuggestion: ${suggestion}`,
          reasoning_graph: taskGraph || {},
          confidence: 0.5,
          reasoning_trace: ['Route: tool_use', 'Feasibility: not achievable', reason],
          conclusion: `Not achievable: ${reason}`,
          route: 'tool_use',
        };
      }
    } catch {
      // feasibility check is best-effort; continue with tool loop
    }
    }

    // ── Rules snapshot: capture current rules BEFORE self-teaching begins ──
    let rulesSnapshotId: string | null = null;
    if (autonomousMode) {
      try {
        const snapRes = await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/rules/snapshot`, {
          session_id: sessionId,
        }, undefined, { timeout: FAST_TIMEOUT_MS });
        rulesSnapshotId = snapRes.data?.snapshot_id || null;
        if (rulesSnapshotId) {
          this.logger.log(
            `Rules snapshot created before self-teaching: ${rulesSnapshotId} (${rules.length} rules)`,
          );
          await this.events.publish('RulesSnapshotCreated', sessionId, {
            snapshot_id: rulesSnapshotId,
            rule_count: rules.length,
            client_message_id: clientMessageId,
          });
        }
      } catch {
        this.logger.warn('Failed to create rules snapshot before self-teaching — continuing');
      }
    }

    let codeKnowledgeBlock = '';
    if (CODE_KNOWLEDGE_IN_TOOL_PLAN) {
      try {
        codeKnowledgeBlock = await fetchCodeKnowledgeSummaryBlock(req.user_message, semanticStructure);
        if (codeKnowledgeBlock) {
          const n = codeKnowledgeBlock.split('\n').filter((l) => l.trim().startsWith('-')).length;
          this.logger.log(`Code knowledge block attached to tool-plan context (${n} symbols)`);
        }
      } catch {
        // best-effort only
      }
    }

    let maxDurationReached = false;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (isAborted()) {
        this.logger.warn(
          'Connection closed before response was sent — stopping tool loop. Causes: user Stop, tab refresh/close, network drop, or proxy idle timeout during long gaps between tool rounds.',
        );
        throw new Error('Pipeline stopped by client');
      }

      // Time limit (autonomous mode)
      if (autonomousMode && Date.now() - loopStartTime > maxDurationMs) {
        this.logger.warn(`Autonomous mode: max duration reached (${sessionCfg.autonomous_max_duration_hours} hrs)`);
        maxDurationReached = true;
        break;
      }

      // Snapshot every 5 iterations in autonomous mode
      if (autonomousMode && iteration > 0 && iteration % 5 === 0) {
        try {
          const snapRes = await axiosWithRetry('post', `${DEV_AGENT_URL}/internal/dev-agent/snapshots/create`, {
            session_id: sessionId,
            iteration_count: iteration,
          }, undefined, { timeout: 15000 });
          if (snapRes.data?.success) {
            await this.events.publish('SnapshotCreated', sessionId, {
              snapshot_id: snapRes.data.snapshot_id,
              iteration_count: iteration,
              client_message_id: clientMessageId,
            });
          }
        } catch {
          // snapshot is best-effort
        }
      }

      // Build knowledge graph summary for autonomous mode (self-teaching)
      let knowledgeGraphSummary = '';
      if (autonomousMode) {
        const achievedCount = (memoryContext || []).filter((m: any) => m?.content?.walls === undefined && !m?.content?.not_achievable).length;
        const notAchievableCount = (memoryContext || []).filter((m: any) => m?.content?.not_achievable).length;
        const scopeLabel = scopeHints.length > 0 ? ` Scope: ${scopeHints.join(', ')}.` : '';
        knowledgeGraphSummary = `[Knowledge graph:${scopeLabel} Walls hit this session: ${wallsHit.length}. Relevant memory entries: ${achievedCount}. Not achievable (avoid): ${notAchievableCount}]\n`;
        knowledgeGraphSummary += `[SELF-TEACHING: A rules snapshot was taken before this session${rulesSnapshotId ? ` (id: ${rulesSnapshotId})` : ''}. You may add, update, or remove rules as needed — the snapshot allows rollback if something goes wrong.]\n\n`;
      }
      if (codeKnowledgeBlock) {
        knowledgeGraphSummary = (knowledgeGraphSummary || '') + codeKnowledgeBlock;
      }

      const toolResultsBeforeIteration = toolResults.length;
      const updateThoughtsOnlyStreak = () => {
        if (toolResults.length === toolResultsBeforeIteration) thoughtsOnlyStreak++;
        else thoughtsOnlyStreak = 0;
      };

      // Hardening: after 3 consecutive iterations with no tool_results,
      // force the model away from "thoughts only" loops.
      if (thoughtsOnlyStreak >= 3) {
        const forceMsg =
          `[FORCE ACTION] You have had ${thoughtsOnlyStreak} consecutive iterations with no tool actions. ` +
          `You MUST output a real tool action (call_tool / teach_rule / update_rule / delete_rule) ` +
          `or a final_answer that satisfies the goal. Do not output "thoughts only".`;
        observerFeedback = observerFeedback ? `${observerFeedback}\n${forceMsg}` : forceMsg;
      }

      // Stagnation-based exploration vs implementation hints (see buildExplorationEscalationGuidance)
      if (explorationState.stagnation === 0) {
        explorationEpisodeBroadenSent = false;
        explorationEpisodeImplementSent = false;
      }
      const exploreKind = buildExplorationEscalationGuidance(
        semanticStructure,
        toolResults,
        explorationState,
        autonomousMode,
      );
      if (exploreKind === 'broaden' && !explorationEpisodeBroadenSent) {
        observerFeedback = observerFeedback ? `${observerFeedback}\n${EXPLORATION_GUIDANCE_BROADEN}` : EXPLORATION_GUIDANCE_BROADEN;
        explorationEpisodeBroadenSent = true;
      } else if (exploreKind === 'implement' && !explorationEpisodeImplementSent) {
        observerFeedback = observerFeedback ? `${observerFeedback}\n${EXPLORATION_GUIDANCE_IMPLEMENT}` : EXPLORATION_GUIDANCE_IMPLEMENT;
        explorationEpisodeImplementSent = true;
      }

      if (autonomousMode && toolUseNeedsImplementationEscalation(semanticStructure, true)) {
        const totalExplore = exploratoryExploreSuccessCount(toolResults);
        const afterWt = exploratorySuccessesAfterLastWorktree(toolResults);
        if (!hasSuccessfulWorktree(toolResults) && totalExplore >= AUTONOMOUS_IMPLEMENT_NUDGE_AFTER_EXPLORE) {
          const n = autonomousExploreWithoutEditMessage(totalExplore);
          observerFeedback = observerFeedback ? `${observerFeedback}\n${n}` : n;
        }
        if (
          hasSuccessfulWorktree(toolResults) &&
          !hasSuccessfulCodeMutation(toolResults) &&
          afterWt >= AUTONOMOUS_WORKTREE_THEN_EDIT_NUDGE_AFTER_READ
        ) {
          const n = autonomousWorktreeButNoEditMessage(afterWt);
          observerFeedback = observerFeedback ? `${observerFeedback}\n${n}` : n;
        }
      }

      // ── Generate & Validate Thoughts ─────────────────────────────────
      // Preserve previous agent thoughts if reasoning layer isn't refreshed —
      // this ensures commitments like "run npm install" survive across iterations
      // until the reasoning layer re-evaluates.
      const previousThoughts = validatedThoughts;
      const lastToolResult = iteration > 0 ? toolResults[toolResults.length - 1] : undefined;
      const shouldRefreshReasoningLayer =
        iteration > 0 &&
        (!lastToolResult?.success || feedbackWarrantsReasoningRefresh(observerFeedback));
      try {
        if (shouldRefreshReasoningLayer) {
          this.logger.log(`Generating thoughts for iteration ${iteration + 1}`);
          const thoughtsRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/thought/generate`, {
            user_message: req.user_message,
            tool_results: toolResults.slice(-5),
            upfront_plan: upfrontPlan.steps.length > 0 ? upfrontPlan : undefined,
            memory_context: memoryContext.length > 0 ? memoryContext : undefined,
            rules: rules.length > 0 ? rules : undefined,
            walls_hit: wallsHit.length > 0 ? wallsHit : undefined,
            observer_feedback: observerFeedback,
          }, undefined, { timeout: FAST_TIMEOUT_MS });

          if (thoughtsRes.data?.thoughts?.length) {
            const validateRes = await axiosWithRetry('post', `${LOGIC_ENGINE_URL}/internal/reason/validate-thoughts`, {
              thoughts: thoughtsRes.data.thoughts,
              memory_context: memoryContext,
              rules: rules,
              walls_hit: wallsHit,
              tool_results: toolResults.slice(-5),
            }, undefined, { timeout: FAST_TIMEOUT_MS });

            const newThoughts = (validateRes.data?.validated_thoughts || []).filter((t: any) => t.validated);
            // Replace only if new thoughts were generated; otherwise keep previous
            if (newThoughts.length > 0) {
              validatedThoughts = newThoughts;
            }
            this.logger.log(`Generated ${thoughtsRes.data.thoughts.length} thoughts, validated ${newThoughts.length}, carrying ${validatedThoughts.length}`);

            if (validatedThoughts.length > 0) {
              await this.events.publish('ThoughtsValidated', sessionId, {
                thought_count: validatedThoughts.length,
                thoughts: validatedThoughts.map((t: any) => ({ thought: t.thought, confidence: t.confidence })),
                client_message_id: clientMessageId,
              });
            }
          }
          // else: no new thoughts generated — keep previousThoughts
        }
        // When reasoning layer is NOT refreshed, validatedThoughts retains
        // previous iteration's value (no reset) — agent thoughts persist
        // until new ones replace them.
      } catch (err: any) {
        this.logger.warn(`Thought layer failed: ${err.message}`);
      }

      // 1. Ask Execution Agent to plan next tool call (or propose final answer)
      this.logger.log(`Tool iteration ${iteration + 1}/${maxIterations}`);
      const planSteps = upfrontPlan?.steps || [];
      const hasPlanSteps = planSteps.length > 0;
      const relativePlanIt = Math.max(0, iteration - planStartIteration);
      const activeStepIndex = hasPlanSteps ? Math.min(relativePlanIt, planSteps.length - 1) : 0;
      const activeStep = hasPlanSteps ? planSteps[activeStepIndex] : undefined;
      const activeStepDescription =
        typeof activeStep === 'string'
          ? activeStep
          : (activeStep as any)?.description || (activeStep as any)?.action || '';

      const focusText = activeStepDescription || req.user_message || '';
      // Scope-aware focus tokens: include path segments from scope hints for better context filtering
      const scopeTokens = scopeHints
        .flatMap((p) => p.split('/'))
        .filter((seg) => seg.length >= 3 && !['src', 'apps', 'services', 'components', 'packages'].includes(seg))
        .map((seg) => seg.toLowerCase().replace(/-/g, '_'));
      const focusTokens = [
        ...new Set([
          ...focusText.toLowerCase().split(/[^a-z0-9_]+/g).filter((t) => t.length >= 4),
          ...scopeTokens,
        ]),
      ].slice(0, 25);

      const scoreText = (s: string) =>
        focusTokens.reduce((acc, t) => acc + (s.includes(t) ? 1 : 0), 0);

      const filteredMemoryContext = memoryContext.length > 0
        ? (() => {
            const scored = memoryContext
              .map((m: any) => {
                const content = m?.content ?? m;
                const str =
                  typeof content === 'string'
                    ? content.toLowerCase()
                    : (() => {
                        try {
                          return JSON.stringify(content).toLowerCase();
                        } catch {
                          return String(content).toLowerCase();
                        }
                      })();
                return { m, score: scoreText(str) };
              })
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map((x) => x.m);
            return scored.length > 0 ? scored : memoryContext.slice(0, 5);
          })()
        : [];

      const filteredRules = rules.length > 0
        ? (() => {
            const scored = rules
              .map((r: any) => {
                const assertion = r?.assertion ?? r?.rule ?? r?.condition ?? r?.conclusion ?? r;
                const str =
                  typeof assertion === 'string'
                    ? assertion.toLowerCase()
                    : (() => {
                        try {
                          return JSON.stringify(assertion).toLowerCase();
                        } catch {
                          return String(assertion).toLowerCase();
                        }
                      })();
                return { r, score: scoreText(str) };
              })
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map((x) => x.r);
            return scored.length > 0 ? scored : rules.slice(0, 5);
          })()
        : [];

      // ── Step 2.1: Re-Thinking & Decision (Mid-loop) ───────────────────────
      // Same gate as validated thoughts: routine observer text alone should not burn an LLM round.
      if (shouldRefreshReasoningLayer) {
        this.logger.log(`Mid-loop reasoning for iteration ${iteration + 1}`);
        const iterationDecisionStartTime = Date.now();
        freeThoughts = await this.generateStreamingThoughts(
          sessionId,
          req.user_message,
          { ...semanticStructure, interactionId, iteration },
          chatHistory,
          interactionId,
          clientMessageId,
          toolResults.slice(-5),
          observerFeedback,
        );

        const iterationDecisionRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/decision`, {
          thoughts: freeThoughts,
          user_message: req.user_message,
          context: { ...req.context, interactionId, iteration },
        }, undefined, { timeout: LLM_TIMEOUT_MS });

        let iterationDecision = iterationDecisionRes.data.decision;
        const timeToIterationDecision = Date.now() - iterationDecisionStartTime;
        const timeToIterationAction = Date.now() - loopStartTime;
        
        // Structured logging for metrics
        this.logger.log(`[DECISION_LOG] iteration=${iteration + 1} decision_type=${iterationDecision} thought_count=1 time_to_decision_ms=${timeToIterationDecision} time_to_action_ms=${timeToIterationAction}`);
        this.logger.log(`Decision Layer [iter ${iteration + 1}]: ${iterationDecision}`);

        if (iterationDecision === 'NEED_MORE_INFO') {
          consecutiveNeedInfo++;
          if (consecutiveNeedInfo >= 2) {
            this.logger.warn(`Overthinking Recovery [iter ${iteration + 1}]: Forced ACT after ${consecutiveNeedInfo} consecutive NEED_MORE_INFO.`);
            iterationDecision = 'ACT';
          }
        } else {
          consecutiveNeedInfo = 0;
        }

        await this.events.publish('DecisionLayerGenerated', sessionId, {
          decision: iterationDecision,
          reason: iterationDecisionRes.data.reason,
          confidence: iterationDecisionRes.data.confidence,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
          iteration,
          forced: consecutiveNeedInfo >= 2,
        });

        if (iterationDecision === 'ANSWER_DIRECTLY') {
          // Don't bail mid-loop if we only have failures — the LLM is giving up too early
          const hasAnySuccess = toolResults.some(r => r.success && !r.blocked && r.tool !== '_system' && r.tool !== 'validation_error');
          if (!hasAnySuccess && iteration < Math.min(3, maxIterations - 1)) {
            this.logger.warn(`Mid-loop ANSWER_DIRECTLY blocked: no successful tool results yet at iteration ${iteration}. Forcing ACT.`);
            iterationDecision = 'ACT';
          } else {
            this.logger.log('Mid-loop Decision: ANSWER_DIRECTLY — terminating loop');
            break; // Planner loop will handle final answer
          }
        }

        if (iterationDecision === 'NEED_MORE_INFO') {
          this.logger.log('Mid-loop Decision: NEED_MORE_INFO — requesting clarification');
          // If we are mid-loop and need info, it might be better to just ask.
          // For now, we'll let the planner decide if it can continue or needs to stop.
        }
      }

      // ── Step 2.2: Formalize Thought as Graph Node ────────────────────────
      // Skip duplicate nodes when we did not refresh freeThoughts this iteration (same text as prior hop).
      if (taskGraph && freeThoughts && (iteration === 0 || shouldRefreshReasoningLayer)) {
        const thoughtNodeId = `thought-${interactionId}-${iteration}`;
        const thoughtNode = {
          id: thoughtNodeId,
          node_type: 'ThoughtNode',
          title: iteration === 0 ? 'Initial Reasoning' : `Rethinking (Step ${iteration + 1})`,
          description: freeThoughts,
          source: 'system',
          confidence: 0.9,
          attributes: { thought: freeThoughts, validated: true },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        
        // Push to graph nodes
        if (!taskGraph.nodes) taskGraph.nodes = [];
        const existingNodeIdx = taskGraph.nodes.findIndex((n: any) => n.id === thoughtNodeId);
        if (existingNodeIdx === -1) {
          taskGraph.nodes.push(thoughtNode);
          
          // Link to goal
          if (taskGraph.edges) {
            const goalNode = taskGraph.nodes.find((n: any) => n.node_type === 'GoalNode');
            if (goalNode) {
              taskGraph.edges.push({
                source_node: thoughtNodeId,
                target_node: goalNode.id,
                edge_type: 'INFORMS'
              });
            }
          }
        }
      }

      // Pass the session's active worktree_id so the LLM never tries to create another one.
      // This survives toolResults.slice(-5) truncation — always visible to the planner.
      const activeWorktreeId =
        this._getSessionWorktreeId(sessionId) ||
        coalesceDevAgentWorktreeId(undefined, toolResults);

      // Build a compact digest of ALL successful tool calls so the LLM knows what
      // ground has been covered, even after toolResults.slice(-5) truncates old entries.
      // Walls cover failures; this covers successes.
      const toolDigest: string[] = [];
      for (const r of toolResults) {
        if (!r.success || r.blocked) continue;
        const t = r.tool;
        if (t === 'grep') toolDigest.push(`✓ grep ${r.pattern || ''} ${r.path || ''}`);
        else if (t === 'read_file' || t === 'read_worktree_file') {
          const range = (r as any).start_line != null ? ` L${(r as any).start_line}-${(r as any).end_line || '?'}` : '';
          // Extract line info from output so the LLM knows it DID read the file
          const truncMatch = (r.output || '').match(/truncated at (\d+) of (\d+) lines/);
          const totalMatch = (r.output || '').match(/^\[(\d+) lines total\]/);
          let lineInfo = '';
          if (truncMatch) lineInfo = ` (read ${truncMatch[1]} of ${truncMatch[2]} lines — content retrieved successfully)`;
          else if (totalMatch) lineInfo = ` (${totalMatch[1]} lines — content retrieved successfully)`;
          else if (r.output && r.output.length > 50) lineInfo = ' (content retrieved successfully)';
          toolDigest.push(`✓ ${t} ${r.path || ''}${range}${lineInfo}`);
        }
        else if (t === 'list_dir' || t === 'find_files') toolDigest.push(`✓ ${t} ${r.path || ''}`);
        else if (t === 'bash') toolDigest.push(`✓ bash ${(r.command || '').slice(0, 80)}`);
        else if (t === 'create_worktree') toolDigest.push(`✓ create_worktree ${(r as any).worktree_id || ''}`);
        else if (t === 'edit_file' || t === 'write_file' || t === 'apply_patch') toolDigest.push(`✓ ${t} ${r.path || ''}`);
        else if (t === 'get_diff') toolDigest.push(`✓ get_diff`);
        else if (t !== '_system' && t !== 'validation_error') toolDigest.push(`✓ ${t}`);
      }

      let plan = await this.generateStreamingToolPlan(
        sessionId,
        interactionId,
        clientMessageId,
        {
          user_message: req.user_message,
          tool_results: toolResults.length > 0 ? toolResults.slice(-8) : null,
          // chat_history omitted: knowledge graph, code graph, memory context,
          // validated thoughts, and tool results provide sufficient context
          // without consuming extra tokens on conversation history.
          upfront_plan: upfrontPlan.steps.length > 0 ? upfrontPlan : undefined,
          active_step_index: hasPlanSteps ? activeStepIndex : undefined,
          active_step_description: activeStepDescription || undefined,
          observer_feedback: observerFeedback || undefined,
          knowledge_summary: knowledgeGraphSummary || undefined,
          memory_context: filteredMemoryContext.length > 0 ? filteredMemoryContext : undefined,
          rules: filteredRules.length > 0 ? filteredRules : undefined,
          memory_stale_hint: memoryStaleHint,
          walls_hit: wallsHit.length > 0 ? wallsHit : undefined,
          task_graph: taskGraph && Object.keys(taskGraph).length > 0 ? taskGraph : undefined,
          validated_thoughts: validatedThoughts.length > 0 ? validatedThoughts : undefined,
          free_thoughts: freeThoughts,
          active_worktree_id: activeWorktreeId || undefined,
          tool_history_digest: toolDigest.length > 2 ? toolDigest : undefined,
          // Artifacts accessed via search_artifacts tool, not auto-injected
        },
        iteration,
        trace,
      );

      // Fetch and publish context budget for UI donut chart
      try {
        const budgetRes = await axios.get(
          `${RESPONSE_URL}/internal/response/context-budget`,
          { timeout: 2000 },
        );
        if (budgetRes.data && !budgetRes.data.error) {
          await this.events.publish('ContextBudgetUpdated', sessionId, {
            ...budgetRes.data,
            iteration,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
        }
      } catch {
        // context budget is best-effort
      }

      // Deterministic last-resort: if we've already observed a long "thoughts only" streak,
      // and the model tries to finalize without producing new tool_results, force a tool call.
      if (thoughtsOnlyStreak >= 3 && plan?.action === 'final_answer' && !plan?._retry_hint) {
        const userMsg = typeof req.user_message === 'string' ? req.user_message : '';
        const tokenMatch = userMsg.match(/[A-Za-z0-9_]{4,}/);
        const fallbackPattern = tokenMatch ? tokenMatch[0] : 'pattern';
        this.logger.warn(`Thought-only recovery: forcing tool action after ${thoughtsOnlyStreak} consecutive no-tool iterations`);
        plan = {
          action: 'call_tool',
          tool: 'grep',
          pattern: fallbackPattern,
          path: '/workspace',
          reasoning: 'Forced action after repeated thoughts-only iterations',
        };
      }

      // Autonomous: cap endless read-only loops by forcing a worktree once (before any worktree exists).
      const exploreOnlyCount = exploratoryExploreSuccessCount(toolResults);
      if (
        autonomousMode &&
        toolUseNeedsImplementationEscalation(semanticStructure, true) &&
        exploreOnlyCount >= AUTONOMOUS_FORCE_WORKTREE_AFTER_EXPLORE &&
        !hasSuccessfulWorktree(toolResults) &&
        !this._getSessionWorktreeId(sessionId) &&
        plan?.action === 'call_tool' &&
        plan.tool &&
        EXPLORATION_TOOLS.has(plan.tool) &&
        !plan?._retry_hint
      ) {
        const wtName = `oasis${iteration}${Math.random().toString(36).slice(2, 6)}`;
        this.logger.warn(
          `Autonomous implement: forcing create_worktree after ${exploreOnlyCount} exploratory successes (was ${plan.tool})`,
        );
        plan = {
          action: 'call_tool',
          tool: 'create_worktree',
          name: wtName,
          reasoning:
            'Autonomous cap: many read-only tools without edits; create a worktree, then edit_file or write_file.',
        };
      }

      // If param validation failed, feed error back as tool result (not a real final_answer)
      if (plan.action === 'final_answer' && plan._retry_hint) {
        this.logger.warn(`Tool param validation error: ${plan.answer}`);
        const valOut = plan.answer || 'Missing required parameters';
        await this.events.publish('ToolCallStarted', sessionId, {
          tool: 'validation_error',
          reasoning: plan.reasoning || 'Plan validation failed — use RETRY format in next tool plan',
          iteration: iteration + 1,
          step_index: activeStepIndex,
          plan_revision: planRevision,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });
        toolResults.push({
          tool: 'validation_error',
          success: false,
          output: valOut,
          blocked: false,
          reasoning: 'Parameter validation failed — retry with correct params',
        });
        await this.events.publish('ToolCallCompleted', sessionId, {
          tool: 'validation_error',
          success: false,
          blocked: false,
          output: valOut.slice(0, 5000),
          output_length: valOut.length,
          iteration: iteration + 1,
          step_index: activeStepIndex,
          plan_revision: planRevision,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });
        updateThoughtsOnlyStreak();
        continue;
      }

      // Guard: don't accept final_answer if the agent hasn't done meaningful work yet.
      if (plan.action === 'final_answer' && iteration < maxIterations - 1) {
        const successfulResults = toolResults.filter(r => r.success && !r.blocked && r.tool !== '_system' && r.tool !== 'validation_error');
        const failedResults = toolResults.filter(r => !r.success && !r.blocked);

        // Case 1: ALL tool calls failed, zero successes — agent is giving up too early
        if (failedResults.length > 0 && successfulResults.length === 0 && iteration < 3) {
          this.logger.warn(
            `Premature final_answer blocked: ${failedResults.length} failures, 0 successes at iteration ${iteration}. Forcing retry.`,
          );
          toolResults.push({
            tool: '_system',
            success: true,
            output:
              `⚠️ You cannot give up yet — all ${failedResults.length} tool call(s) failed but you have NOT tried alternatives. ` +
              `Try: different search patterns, different paths, broader grep, list_dir to discover structure. ` +
              `Do NOT propose final_answer until you have at least one successful tool result.`,
            blocked: false,
            reasoning: 'System: blocked premature final_answer after only failures',
          });
          continue;
        }

        // Case 2: Impl request but agent only read files and is punting instead of editing.
        // This catches "I was unable to access the file" / "I can guide you" cop-outs.
        const implKw = ['implement', 'add', 'create', 'build', 'fix', 'modify', 'update', 'enable', 'install', 'set up', 'refactor', 'change', 'write'];
        const goalLower = (req.user_message || '').toLowerCase();
        const isImpl = implKw.some(kw => goalLower.includes(kw));
        const EDIT_TOOLS = new Set(['create_worktree', 'write_file', 'edit_file', 'apply_patch', 'get_diff']);
        const madeEdits = successfulResults.some(r => EDIT_TOOLS.has(r.tool));

        if (isImpl && !madeEdits) {
          // Primary: LLM-based punt detection
          let isPunting = false;
          let puntReason = '';
          try {
            const puntRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/response/punt-check`, {
              user_goal: req.user_message,
              proposed_answer: plan.answer || '',
              has_code_edits: false,
            }, undefined, { timeout: 5000 });
            isPunting = puntRes.data?.is_punt === true;
            puntReason = puntRes.data?.reason || 'LLM detected punt';
          } catch {
            // Fallback: phrase-based detection
            const ansLower = (plan.answer || '').toLowerCase();
            const PUNT_PHRASES = [
              'you\'ll need to', 'you will need to', 'you can ', 'i can guide',
              'i was unable', 'i wasn\'t able', 'i couldn\'t', 'i could not',
              'here\'s how', 'however, i can', 'unfortunately', 'however, you',
              'you should ', 'you may want', 'you might want',
              'would you like me to', 'shall i ', 'do you want me to',
              'should i ', 'want me to ', 'if you\'d like me to',
              'i can also ', 'i could also ', 'let me know if',
              'i\'ll need to', 'the next step would be', 'the next step is',
              'no modifications were made', 'no changes were made',
              'due to size limitations', 'which is quite large',
              'due to a tool limitation', 'requires careful handling',
              'would you like me to focus', 'focus on any specific part',
              // Announcing plans without executing
              'let me proceed', 'i\'ll proceed', 'i will proceed',
              'the task requires', 'based on the existing code',
              'i noticed that', 'looking at the code',
            ];
            isPunting = PUNT_PHRASES.some(p => ansLower.includes(p));
            puntReason = 'phrase match fallback';
          }

          if (isPunting) {
            this.logger.warn(
              `Premature final_answer blocked (${puntReason}): impl request but no edits. Answer: "${(plan.answer || '').slice(0, 80)}"`,
            );
            toolResults.push({
              tool: '_system',
              success: true,
              output:
                `⚠️ BLOCKED: You are punting an implementation task to the user. This is NOT acceptable. ` +
                `You have read files successfully — now ACT on them:\n` +
                `1. If you haven't created a worktree yet → create_worktree\n` +
                `2. If the file is too large to read fully → use start_line/end_line for chunked reads\n` +
                `3. Apply your changes with apply_patch or edit_file\n` +
                `4. Show the diff with get_diff\n` +
                `Do NOT tell the user to do it. DO IT YOURSELF.`,
              blocked: false,
              reasoning: 'System: blocked punt on impl request — agent must edit, not advise',
            });
            continue;
          }
        }
      }

      // If LLM proposes final_answer, validate with Observer first
      if (plan.action === 'final_answer') {
        try {
          const obsRes = await axiosWithRetry('post', `${OBSERVER_URL}/internal/observer/validate`, {
            user_goal: semanticStructure?.problem || req.user_message,
            semantic_structure: semanticStructure,
            task_graph: taskGraph,
            tool_results: toolResults,
            plan: upfrontPlan,
            session_id: sessionId,
            memory_context: memoryContext,
            rules,
            memory_stale_hint: memoryStaleHint,
            validated_thoughts: validatedThoughts.length > 0 ? validatedThoughts : undefined,
            proposed_final_answer: plan.answer || undefined,
          }, undefined, { timeout: OBSERVER_VALIDATE_TIMEOUT_MS });
          if (obsRes.data.goal_met) {
            // Gateway-side punt guard: even if observer says goal_met, reject if the agent
            // is punting an implementation task to the user without making any code changes.
            const implKw = ['implement', 'add', 'create', 'build', 'fix', 'modify', 'update', 'enable', 'install', 'set up', 'refactor', 'change', 'write'];
            const goalLower = (req.user_message || '').toLowerCase();
            const isImpl = implKw.some(kw => goalLower.includes(kw));
            const madeEdits = toolResults.some(r =>
              r.success && ['create_worktree', 'write_file', 'edit_file', 'apply_patch', 'get_diff'].includes(r.tool),
            );

            // Only run punt check on impl requests without edits — skip if agent actually edited code
            if (isImpl && !madeEdits && iteration < maxIterations - 1) {
              // Primary: LLM-based punt detection (more accurate than phrase matching)
              let isPunt = false;
              let puntReason = '';
              try {
                const puntRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/response/punt-check`, {
                  user_goal: req.user_message,
                  proposed_answer: plan.answer || '',
                  has_code_edits: false,
                }, undefined, { timeout: 5000 });
                isPunt = puntRes.data?.is_punt === true;
                puntReason = puntRes.data?.reason || '';
              } catch (puntErr: any) {
                // Fallback: phrase-based punt detection when LLM check fails
                this.logger.warn(`LLM punt check failed: ${puntErr.message} — falling back to phrase match`);
                const ansLower = (plan.answer || '').toLowerCase();
                const PUNT_PHRASES = [
                  'you\'ll need to', 'you will need to', 'you can ', 'i can guide',
                  'i was unable to', 'i wasn\'t able to', 'i couldn\'t', 'i could not',
                  'here\'s how', 'however, i can', 'unfortunately',
                  'would you like me to', 'shall i ', 'do you want me to',
                  'should i ', 'want me to ', 'let me know if',
                  'no modifications were made', 'no changes were made',
                  'due to size limitations', 'which is quite large',
                  'due to a tool limitation', 'requires careful handling',
                  'would you like me to focus', 'focus on any specific part',
                  // Announcing plans without executing
                  'let me proceed', 'i\'ll proceed', 'i will proceed',
                  'the task requires', 'based on the existing code',
                  'i noticed that', 'looking at the code',
                ];
                isPunt = PUNT_PHRASES.some(p => ansLower.includes(p));
                puntReason = 'phrase match fallback';
              }

              if (isPunt) {
                this.logger.warn(
                  `Punt detected (${puntReason}): observer said goal_met but agent is punting. Answer: "${(plan.answer || '').slice(0, 80)}"`,
                );
                observerFeedback =
                  'The observer accepted your answer but you are PUNTING the task to the user. ' +
                  'You MUST implement it yourself: create_worktree → read the file with chunked reads (start_line/end_line) → apply_patch/edit_file → get_diff. ' +
                  'Do NOT tell the user how to do it — DO IT.';
                taskGraph = obsRes.data.updated_graph || taskGraph;
                updateThoughtsOnlyStreak();
                continue;
              }
            }

            taskGraph = obsRes.data.updated_graph || taskGraph;
            await this.events.publish('ToolUseComplete', sessionId, {
              tool_calls: toolResults.length,
              interaction_id: interactionId,
              client_message_id: clientMessageId,
            });
            // Store task graph + walls (Knowledge Graph) so future sessions avoid same mistakes
            if (taskGraph && Object.keys(taskGraph).length > 0) {
              try {
                await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/store`, {
                  reasoning_graph: taskGraph,
                  user_id: 'default',
                  session_id: sessionId,
                  walls: wallsHit.length > 0 ? wallsHit : undefined,
                }, undefined, { timeout: FAST_TIMEOUT_MS });
              } catch {
                // store is best-effort
              }
            }
            const responseText = plan.answer || 'Done.';
            await this.events.publish('ResponseGenerated', sessionId, {
              response_length: responseText.length,
              interaction_id: interactionId,
              client_message_id: clientMessageId,
            });
            toolSpan?.end({ output: { tool_calls: toolResults.length, response_length: responseText.length } });
            trace?.update({ output: { response: responseText, route: 'tool_use' } });
            return {
              session_id: sessionId,
              response: responseText,
              reasoning_graph: taskGraph || {},
              confidence: 1.0,
              reasoning_trace: [
                `Route: tool_use`,
                `Tool calls: ${toolResults.length}`,
                ...toolResults.map((r, i) => `  #${i + 1} ${r.tool}: ${r.command || r.path || r.url || '?'} → ${r.success ? 'OK' : r.blocked ? 'BLOCKED' : 'FAILED'}`),
              ],
              route: 'tool_use',
            };
          }
          observerFeedback = obsRes.data.feedback || 'Continue working on the task.';
          taskGraph = obsRes.data.updated_graph || taskGraph;
          if (obsRes.data.revise_plan) {
            const replanned = await runObserverReplan(observerFeedback || 'Continue working on the task.', iteration);
            if (replanned) {
              observerFeedback =
                `${observerFeedback}\n[SYSTEM: The upfront plan was revised. Execute from step 1 of the new plan — follow the updated Execution plan in the UI.]`;
            }
          }
        } catch (obsErr: any) {
          this.logger.warn(`Observer validate failed: ${obsErr.message} — applying fallback validation`);
          // Fallback: if Observer is down, do a basic check —
          // for implementation requests, reject if agent only read/grepped and didn't edit code
          const implKeywords = ['implement', 'add', 'create', 'build', 'fix', 'modify', 'update', 'enable', 'install', 'set up', 'refactor', 'change', 'write'];
          const userGoalLower = (req.user_message || '').toLowerCase();
          const isImplRequest = implKeywords.some(kw => userGoalLower.includes(kw));
          const toolsUsed = new Set(toolResults.map(r => r.tool));
          const hasCodeEdits =
            toolsUsed.has('create_worktree') ||
            toolsUsed.has('write_file') ||
            toolsUsed.has('edit_file') ||
            toolsUsed.has('apply_patch') ||
            toolsUsed.has('get_diff');
          const answerLower = (plan.answer || '').toLowerCase();
          const PUNT_PHRASES = [
            // Instructing / advising user
            'you\'ll need to', 'you will need to', 'you can ', 'you could ',
            'please install', 'please run', 'let me know', 'if you\'d like',
            'i can provide', 'i can guide', 'i can help you', 'here\'s how',
            'here is how', 'i was unable to', 'i wasn\'t able to', 'i could not',
            'i couldn\'t', 'however, i can', 'unfortunately, i',
            'you should ', 'you may want to', 'you might want to',
            'i recommend that you', 'consider adding', 'consider using',
            // Asking permission instead of doing it
            'would you like me to', 'shall i ', 'do you want me to',
            'should i ', 'want me to ', 'let me know if',
            // Announcing without acting
            'no modifications were made', 'no changes were made',
            // Blaming file size / tool limitations
            'due to size limitations', 'which is quite large',
            'due to a tool limitation', 'requires careful handling',
            'would you like me to focus', 'focus on any specific part',
            // Announcing plans without executing
            'let me proceed', 'i\'ll proceed', 'i will proceed',
            'the task requires', 'based on the existing code',
            'i noticed that', 'looking at the code',
          ];
          const isPuntingToUser = PUNT_PHRASES.some(p => answerLower.includes(p));

          if (isImplRequest && !hasCodeEdits && (isPuntingToUser || toolResults.length <= 3)) {
            // Agent is being lazy — force it to continue
            this.logger.warn('Fallback validation: agent punted impl request to user — forcing continuation');
            observerFeedback = 'You MUST implement this yourself. Create a worktree, edit the files, and show the diff. Do NOT ask the user to do it.';
            updateThoughtsOnlyStreak();
            continue;
          }
          // Otherwise accept the answer
          await this.events.publish('ToolUseComplete', sessionId, {
            tool_calls: toolResults.length,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
          const responseText = plan.answer || 'Done.';
          await this.events.publish('ResponseGenerated', sessionId, {
            response_length: responseText.length,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
          toolSpan?.end({ output: { tool_calls: toolResults.length, response_length: responseText.length } });
          trace?.update({ output: { response: responseText, route: 'tool_use' } });
          return {
            session_id: sessionId,
            response: responseText,
            reasoning_graph: taskGraph || {},
            confidence: 1.0,
            reasoning_trace: [
              `Route: tool_use`,
              `Tool calls: ${toolResults.length}`,
              ...toolResults.map((r, i) => `  #${i + 1} ${r.tool}: ${r.command || r.path || r.url || '?'} → ${r.success ? 'OK' : r.blocked ? 'BLOCKED' : 'FAILED'}`),
            ],
            route: 'tool_use',
          };
        }
        // final_answer proposal did not complete (Observer rejected it), so no new tool_results.
        // Count it towards the "thoughts only" streak so we can force an ACT after 3.
        updateThoughtsOnlyStreak();
        continue;
      }

      // 2a. Self-teaching actions — agent creates/updates/deletes rules
      if (plan.action === 'teach_rule') {
        // Strip leading "IF " / "THEN " prefixes to avoid duplication (agent may include them)
        const cleanCondition = (plan.condition || '').replace(/^IF\s+/i, '').trim();
        const cleanConclusion = (plan.conclusion || plan.rule || '').replace(/^THEN\s+/i, '').trim();
        try {
          await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/teach`, {
            assertion: cleanConclusion,
            category: 'rule',
            domain: plan.domain || 'general',
            confidence: plan.confidence ?? 0.8,
            supporting_sources: [],
            underlying_concept: cleanCondition,
          }, undefined, { timeout: FAST_TIMEOUT_MS });
          toolResults.push({
            tool: 'teach_rule',
            success: true,
            output: `Rule created: IF ${cleanCondition || '?'} THEN ${cleanConclusion || '?'}`,
            blocked: false,
            reasoning: plan.reasoning,
          });
          this.logger.log(`Self-teaching: rule created — ${plan.conclusion?.slice(0, 80)}`);
          await this.events.publish('TeachingKnowledgeStored', sessionId, {
            assertion: plan.conclusion || '',
            confidence: plan.confidence ?? 0.8,
            stored_as: 'rules',
            self_taught: true,
            client_message_id: clientMessageId,
          });
          // Refresh rules for next iteration
          try {
            const rulesRefresh = await axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, undefined, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 });
            rules = rulesRefresh.data.rules || rules;
          } catch { /* best-effort */ }
        } catch (err: any) {
          toolResults.push({ tool: 'teach_rule', success: false, output: `Failed to create rule: ${err.message}`, blocked: false, reasoning: plan.reasoning });
        }
        updateThoughtsOnlyStreak();
        continue;
      }
      if (plan.action === 'update_rule') {
        try {
          await axiosWithRetry('patch', `${MEMORY_URL}/internal/memory/rules`, {
            rule_id: plan.rule_id,
            condition: plan.condition || undefined,
            conclusion: plan.conclusion || undefined,
            confidence: plan.confidence ?? undefined,
          }, undefined, { timeout: FAST_TIMEOUT_MS });
          toolResults.push({ tool: 'update_rule', success: true, output: `Rule ${plan.rule_id} updated`, blocked: false, reasoning: plan.reasoning });
          // Refresh rules
          try {
            const rulesRefresh = await axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, undefined, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 });
            rules = rulesRefresh.data.rules || rules;
          } catch { /* best-effort */ }
        } catch (err: any) {
          toolResults.push({ tool: 'update_rule', success: false, output: `Failed to update rule: ${err.message}`, blocked: false, reasoning: plan.reasoning });
        }
        updateThoughtsOnlyStreak();
        continue;
      }
      if (plan.action === 'delete_rule') {
        try {
          await axiosWithRetry('delete', `${MEMORY_URL}/internal/memory/rules`, {
            data: { rule_id: plan.rule_id },
          }, undefined, { timeout: FAST_TIMEOUT_MS });
          toolResults.push({ tool: 'delete_rule', success: true, output: `Rule ${plan.rule_id} deleted`, blocked: false, reasoning: plan.reasoning });
          // Refresh rules
          try {
            const rulesRefresh = await axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, undefined, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 });
            rules = rulesRefresh.data.rules || rules;
          } catch { /* best-effort */ }
        } catch (err: any) {
          toolResults.push({ tool: 'delete_rule', success: false, output: `Failed to delete rule: ${err.message}`, blocked: false, reasoning: plan.reasoning });
        }
        updateThoughtsOnlyStreak();
        continue;
      }

      // 2b. Execute the planned tool call
      if (plan.action === 'call_tool') {
        let toolName = plan.tool || 'bash';
        const command = plan.command || '';
        const path = plan.path || '';
        const pattern = plan.pattern || '';
        const url = plan.url || '';
        if (!isKnownExecutorTool(toolName)) {
          const canonical = canonicalizeToolAlias(toolName);
          if (canonical.tool) {
            this.logger.log(`Resolved prose/alias tool name "${plan.tool}" → ${canonical.tool}`);
            toolName = canonical.tool;
            plan.tool = canonical.tool;
          } else {
            const toolParamHint: Record<string, string> = {
              search_artifacts: 'PARAM_QUERY: <natural language search query>\nPARAM_LIMIT: (optional, default 8)',
              read_artifact: 'PARAM_ARTIFACT_ID: <artifact ID from search_artifacts results>',
              grep: 'PARAM_PATTERN: <regex/keyword>\nPARAM_PATH: /workspace',
              find_files: 'PARAM_PATTERN: <glob>\nPARAM_PATH: /workspace',
              read_file: 'PARAM_PATH: /workspace/<path>\nPARAM_START_LINE: (optional) 1-based start line\nPARAM_END_LINE: (optional) 1-based end line (inclusive)',
              list_dir: 'PARAM_PATH: /workspace\nPARAM_RECURSIVE: true',
              browse_url: 'PARAM_URL: <https://...>',
              bash:
                'PARAM_COMMAND: shell command\nPARAM_WORKTREE_ID: for npm/pnpm/yarn/pip install — paste the exact id from create_worktree (e.g. feat-highlight), not English or angle brackets',
              create_worktree:
                'PARAM_NAME: short id (letters, numbers, hyphens, underscores; no spaces or slashes), e.g. workspace or feat-highlight',
              write_file:
                'PARAM_WORKTREE_ID: exact id string from create_worktree output (e.g. feat-highlight)\nPARAM_PATH: /workspace/<path> or repo-relative (e.g. apps/...)\nPARAM_CONTENT: <text>',
              edit_file:
                'PARAM_WORKTREE_ID: exact id from create_worktree (same session)\nPARAM_PATH: /workspace/<path> or repo-relative\nPARAM_OLD_STRING: <exact old text>\nPARAM_NEW_STRING: <replacement>',
              apply_patch:
                'PARAM_WORKTREE_ID: exact id from create_worktree\nPARAM_PATCH: unified diff — MUST have: "--- a/<path>" and "+++ b/<path>" headers, "@@ -start,count +start,count @@" with ACCURATE counts, context lines with leading SPACE. Read the file first and copy context lines exactly.',
              read_worktree_file:
                'PARAM_WORKTREE_ID: exact id from create_worktree\nPARAM_PATH: /workspace/<path> or repo-relative\nPARAM_START_LINE: (optional) 1-based start line\nPARAM_END_LINE: (optional) 1-based end line (inclusive)',
              get_diff: '',
              computer_action:
                'PARAM_ACTION: screenshot | click | double_click | right_click | type_text | key_press | hotkey | scroll | mouse_move | get_screen_size\n' +
                'PARAM_X: pixel x-coordinate (for click/mouse_move/scroll)\n' +
                'PARAM_Y: pixel y-coordinate (for click/mouse_move/scroll)\n' +
                'PARAM_TEXT: text to type (for type_text)\n' +
                'PARAM_KEY: key name (for key_press, e.g. enter, tab, escape)\n' +
                'PARAM_KEYS: array of keys (for hotkey, e.g. ["command","c"])\n' +
                'PARAM_DIRECTION: up|down (for scroll)\n' +
                'PARAM_AMOUNT: scroll amount (default 3)',
            };
            const suggested = extractToolFromProse(toolName);
            const hintBlock = suggested
              ? `\n\nRETRY IN NEXT TOOL PLAN (UPDATE YOUR ACTION):\nDECISION: ACT\nACTION: ${suggested}\n${toolParamHint[suggested] ? toolParamHint[suggested] : ''}`.trimEnd()
              : '';
            const invalidOut =
              `INVALID TOOL: "${toolName}" is not a real tool. Allowed: ${KNOWN_CALL_TOOLS_SORTED.join(', ')}.\n${canonical.reason || 'If you meant an alias (e.g. edit → edit_file), update ACTION accordingly.'}${hintBlock}`;
            await this.events.publish('ToolCallStarted', sessionId, {
              tool: toolName.slice(0, 120),
              command: command || undefined,
              path: path || undefined,
              pattern: pattern || undefined,
              url: url || undefined,
              reasoning: plan.reasoning || 'Invalid tool name — see completion output for retry format',
              iteration: iteration + 1,
              step_index: activeStepIndex,
              plan_revision: planRevision,
              interaction_id: interactionId,
              client_message_id: clientMessageId,
            });
            toolResults.push({
              tool: toolName.slice(0, 120),
              command: command || undefined,
              path: path || undefined,
              pattern: pattern || undefined,
              url: url || undefined,
              success: false,
              output: invalidOut,
              blocked: false,
              reasoning: plan.reasoning,
            });
            await this.events.publish('ToolCallCompleted', sessionId, {
              tool: toolName.slice(0, 120),
              success: false,
              blocked: false,
              output: invalidOut.slice(0, 5000),
              output_length: invalidOut.length,
              iteration: iteration + 1,
              step_index: activeStepIndex,
              plan_revision: planRevision,
              interaction_id: interactionId,
              client_message_id: clientMessageId,
            });
            consecutiveFailures++;
            updateThoughtsOnlyStreak();
            continue;
          }
        }

        // ── Artifact-hunting interception: block attempts to explore disk for artifact content ──
        // When artifact search results are available, the LLM sometimes tries to list_dir /data,
        // /artifacts, /documents, /uploads etc. looking for files that don't exist on disk.
        // The artifact content is already in the LLM's context via RAG — intercept and redirect.
        {
          const normalizedPath = (path || '').toLowerCase().replace(/\/+$/, '');
          const normalizedCmd = (command || '').toLowerCase();
          const ARTIFACT_HUNT_PATHS = ['/data', '/artifacts', '/documents', '/uploads', '/files', '/attachments',
            '/workspace/data', '/workspace/artifacts', '/workspace/documents', '/workspace/uploads',
            '/workspace/files', '/workspace/attachments'];
          const isArtifactHunt =
            // list_dir or find_files targeting artifact-like paths
            ((toolName === 'list_dir' || toolName === 'find_files') &&
              ARTIFACT_HUNT_PATHS.some(p => normalizedPath === p || normalizedPath.startsWith(p + '/'))) ||
            // bash commands trying to find artifact directories
            (toolName === 'bash' && /artifact|\/data\b|\/uploads\b/i.test(normalizedCmd) &&
              /find |ls |locate /.test(normalizedCmd));

          if (isArtifactHunt) {
            const redirectMsg =
              `⛔ WRONG TOOL: User documents are NOT files on disk.\n\n` +
              `There is NO /data/, /artifacts/, /documents/, or /uploads/ directory. ` +
              `User-uploaded documents are stored in a knowledge base accessible ONLY via search_artifacts and read_artifact tools.\n\n` +
              `To access user documents:\n` +
              `Step 1 — search: ACTION: search_artifacts / PARAM_QUERY: <your search query>  (returns summaries + artifact IDs)\n` +
              `Step 2 — drill down: ACTION: read_artifact / PARAM_ARTIFACT_ID: <id from step 1>  (returns full content)`;
            this.logger.warn(
              `Artifact-hunting intercepted: ${toolName} ${path || pattern || command} — redirecting to use in-context artifacts`,
            );
            toolResults.push({
              tool: toolName,
              command: command || undefined,
              path: path || undefined,
              pattern: pattern || undefined,
              success: false,
              output: redirectMsg,
              blocked: false,
              reasoning: 'System: user documents are in knowledge base, use search_artifacts tool',
            });
            updateThoughtsOnlyStreak();
            continue;
          }
        }

        // ── Duplicate call detection: reject repeated identical tool calls (normalized paths / whitespace)
        // edit_file / write_file MUST NOT use path-only signatures — each patch has different old/new (or content);
        // otherwise the 2nd+ edit to the same file is wrongly blocked as "duplicate".
        const normCmd = (command || '').replace(/\s+/g, ' ').trim();
        const skipDuplicateCheck =
          toolName === 'edit_file' || toolName === 'write_file' || toolName === 'apply_patch' || toolName === 'computer_action';

        // For read tools: skip duplicate check if the same path was edited since the last read.
        // Re-reading after an edit is mandatory (file content changed), not a duplicate.
        const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch']);
        const isReadAfterEdit =
          !skipDuplicateCheck &&
          (toolName === 'read_file' || toolName === 'read_worktree_file') &&
          path &&
          (() => {
            const normPath = normalizePathForToolSignature(path);
            // Walk backwards: find the last read of this path, then check if any write happened after it
            let lastReadIdx = -1;
            for (let i = toolResults.length - 1; i >= 0; i--) {
              if (
                (toolResults[i].tool === 'read_file' || toolResults[i].tool === 'read_worktree_file') &&
                normalizePathForToolSignature(toolResults[i].path) === normPath
              ) {
                lastReadIdx = i;
                break;
              }
            }
            if (lastReadIdx === -1) return false; // no prior read — normal duplicate check
            // Check if any write tool touched this path after the last read
            for (let i = lastReadIdx + 1; i < toolResults.length; i++) {
              const r = toolResults[i];
              if (!WRITE_TOOLS.has(r.tool)) continue;
              // apply_patch may not have a path field (it's in the diff) — check if successful
              if (r.tool === 'apply_patch' && r.success) return true;
              if (normalizePathForToolSignature(r.path) === normPath && r.success) return true;
            }
            return false;
          })();

        const callSignature = JSON.stringify({
          tool: toolName,
          command: normCmd,
          path: normalizePathForToolSignature(path),
          pattern: (pattern || '').trim(),
          url: (url || '').trim(),
          recursive: plan.recursive || false,
          start_line: plan.start_line != null ? Number(plan.start_line) : undefined,
          end_line: plan.end_line != null ? Number(plan.end_line) : undefined,
        });
        const priorSameCall = (skipDuplicateCheck || isReadAfterEdit)
          ? []
          : toolResults.filter(r =>
              JSON.stringify({
                tool: r.tool,
                command: (r.command || '').replace(/\s+/g, ' ').trim(),
                path: normalizePathForToolSignature(r.path),
                pattern: (r.pattern || '').trim(),
                url: (r.url || '').trim(),
                recursive: (r as any).recursive || false,
                start_line: (r as any).start_line != null ? Number((r as any).start_line) : undefined,
                end_line: (r as any).end_line != null ? Number((r as any).end_line) : undefined,
              }) === callSignature,
            );
        if (isReadAfterEdit) {
          this.logger.log(`Read-after-edit: allowing re-read of ${path} (file was modified since last read)`);
        }
        if (priorSameCall.length > 0) {
          const prior = priorSameCall[priorSameCall.length - 1];
          const priorSucceeded = !!(prior.success && !prior.blocked);
          const priorFullOutput = prior.output ?? '';

          if (priorSucceeded && CACHED_DUPLICATE_READ_TOOLS.has(toolName)) {
            consecutiveDuplicates++;
            this.logger.log(
              `Duplicate ${toolName} (same params) — returning cached output (${priorFullOutput.length} chars) [streak=${consecutiveDuplicates}]`,
            );

            // After 3 consecutive cached duplicates, stop caching and force a redirect instead.
            // The LLM is stuck in a read→attempt→read→attempt loop.
            if (consecutiveDuplicates >= 3) {
              this.logger.warn(
                `Duplicate loop detected: ${consecutiveDuplicates} consecutive cached reads of same file. Breaking cache to force redirect.`,
              );
              // Fall through to the redirect path below instead of returning cached data
            } else {
              const cachedRead: (typeof toolResults)[number] = {
                tool: toolName,
                command: command || undefined,
                path: path || undefined,
                pattern: pattern || undefined,
                url: url || undefined,
                success: true,
                output:
                  priorFullOutput +
                  (priorFullOutput
                    ? '\n\n[Cached: identical read — same parameters as an earlier successful call.]'
                    : ''),
                blocked: false,
                reasoning: 'Cached duplicate read',
              };
              if (prior.read_metadata) {
                cachedRead.read_metadata = prior.read_metadata;
              }
              toolResults.push(cachedRead);
              updateExplorationStateFromToolResult(
                toolResults[toolResults.length - 1],
                explorationState,
                semanticStructure,
                autonomousMode,
              );
              updateThoughtsOnlyStreak();
              continue;
            }
          }

          consecutiveDuplicates++;
          this.logger.warn(
            `Duplicate tool call detected: ${toolName} ${path || pattern || command} — injecting redirect [streak=${consecutiveDuplicates}]`,
          );

          // Hard-break: if the LLM keeps repeating duplicates despite redirects, stop the loop.
          if (consecutiveDuplicates >= 5) {
            this.logger.warn(
              `Duplicate deadlock: ${consecutiveDuplicates} consecutive duplicate calls — terminating tool loop.`,
            );
            toolResults.push({
              tool: '_system',
              success: false,
              output:
                `⛔ DUPLICATE DEADLOCK: You have made ${consecutiveDuplicates} consecutive duplicate tool calls. ` +
                `The loop is being terminated. Summarize what you accomplished and present your findings to the user.`,
              blocked: false,
              reasoning: 'System: terminated due to duplicate deadlock',
            });
            break;
          }

          const priorRm = prior.read_metadata as ReadFileMetadata | undefined;
          const priorOutput = priorFullOutput.slice(0, 500) || '(no output)';
          // Tailor the redirect: for truncated file reads, the LLM needs chunked reads, not a generic hint
          const wasTruncatedRead =
            (toolName === 'read_file' || toolName === 'read_worktree_file') &&
            priorSucceeded &&
            (Boolean(priorRm?.truncated_by_line_cap) ||
              Boolean(priorRm?.truncated_by_byte_cap) ||
              /truncated at \d+ of \d+ lines/.test(priorFullOutput));
          const truncMatch = priorFullOutput.match(/truncated at (\d+) of (\d+) lines/);

          let dupHint: string;
          if (wasTruncatedRead && (truncMatch || priorRm)) {
            const shown =
              truncMatch?.[1] ??
              (priorRm?.source_line_end != null ? String(priorRm.source_line_end) : '500');
            const total =
              truncMatch?.[2] ??
              (priorRm?.total_lines != null ? String(priorRm.total_lines) : shown);
            const nextStart =
              priorRm?.next_chunk_start_line != null
                ? priorRm.next_chunk_start_line
                : Number(shown) + 1;
            const totalN = Number(total);
            const nextEnd = Number.isFinite(totalN)
              ? Math.min(nextStart + 99, totalN)
              : nextStart + 99;
            dupHint =
              `DUPLICATE CALL BLOCKED: You already read ${path || 'this file'} — it has ${total} lines but was truncated at ${shown}. ` +
              `Do NOT re-read the full file. Use CHUNKED READS to see more:\n` +
              `- ${toolName} path=${path || '...'} start_line=${nextStart} end_line=${nextEnd}\n` +
              `- Or use grep to find the exact function/section you need, then read just those lines ±15.\n` +
              `- You already have lines 1-${shown}. Use that data to start editing, or read the next chunk.`;
          } else if (priorSucceeded) {
            dupHint =
              `DUPLICATE CALL BLOCKED: This ${toolName} call already **succeeded** with the same parameters. The output was:\n${priorOutput}\n\nDo NOT repeat successful work. Next step:\n` +
              `- Use the data you already have to proceed (edit_file, apply_patch, create_worktree)\n` +
              `- If you need a DIFFERENT section of the file, use start_line/end_line params for a chunked read\n` +
              `- Change pattern/path/command if you truly need another pass`;
          } else {
            dupHint =
              `DUPLICATE CALL BLOCKED: You already called ${toolName} with these exact parameters. The previous result was:\n${priorOutput}\n\nDo NOT repeat the same call. Instead:\n` +
              `- If the result was useful, DRILL DEEPER (read a file you found, or list_dir into a subdirectory)\n` +
              `- If the result was empty, try DIFFERENT keywords or a DIFFERENT path\n` +
              `- If you have enough info, proceed to create_worktree and implement the changes`;
          }
          toolResults.push({
            tool: toolName,
            command: command || undefined,
            path: path || undefined,
            pattern: pattern || undefined,
            url: url || undefined,
            success: false,
            output: dupHint,
            blocked: false,
            reasoning: 'Duplicate call intercepted by system',
          });
          updateExplorationStateFromToolResult(
            toolResults[toolResults.length - 1],
            explorationState,
            semanticStructure,
            autonomousMode,
          );
          updateThoughtsOnlyStreak();
          continue;
        }

        // ── search_artifacts (Level 1): returns summaries grouped by artifact ──
        if (toolName === 'search_artifacts') {
          const query = plan.query || plan.pattern || path || command || req.user_message;
          const artProjectId = req.context?.project_id;
          // Detect re-search loop: if search_artifacts already returned results, redirect to read_artifact
          const priorSearchResult = toolResults.find(
            r => r.tool === 'search_artifacts' && r.success && r.output?.includes('matching document(s)'),
          );
          if (priorSearchResult) {
            this.logger.warn(`search_artifacts re-search blocked (query="${(query || '').slice(0, 80)}") — prior search already returned results`);
            toolResults.push({
              tool: 'search_artifacts',
              pattern: query || undefined,
              success: true,
              output:
                `⛔ You already searched artifacts and got results. Do NOT re-search with different keywords.\n\n` +
                `Instead, drill down into the results you already have using:\n` +
                `ACTION: read_artifact\nPARAM_ARTIFACT_ID: <artifact_id from previous search results>\n\n` +
                `Previous search results (still valid):\n${priorSearchResult.output?.slice(0, 3000) || '(see above)'}`,
              blocked: false,
              reasoning: 'Re-search blocked — use read_artifact to drill down',
            });
            updateThoughtsOnlyStreak();
            continue;
          }
          this.logger.log(`search_artifacts: query="${(query || '').slice(0, 100)}" project=${artProjectId}`);
          const results = await fetchArtifactSearchResults(query, artProjectId, plan.limit ? Number(plan.limit) : 8);
          if (results.length > 0) {
            // Deduplicate by artifact_id, keep highest similarity per artifact
            const byArtifact = new Map<string, { artifact_name: string; similarity: number; chunk_texts: string[] }>();
            for (const r of results) {
              const existing = byArtifact.get(r.artifact_id);
              if (existing) {
                existing.similarity = Math.max(existing.similarity, r.similarity);
                existing.chunk_texts.push(r.chunk_text);
              } else {
                byArtifact.set(r.artifact_id, {
                  artifact_name: r.artifact_name,
                  similarity: r.similarity,
                  chunk_texts: [r.chunk_text],
                });
              }
            }
            // Fetch summaries for unique artifacts in parallel
            const artifactIds = [...byArtifact.keys()];
            const summaries = await Promise.all(
              artifactIds.map(async (aid) => {
                const artifact = await fetchArtifactById(aid);
                return { aid, summary: artifact?.summary || null };
              }),
            );
            const summaryMap = new Map(summaries.map(s => [s.aid, s.summary]));
            // Format output: summary-first, with artifact IDs for drill-down
            const formatted = artifactIds.map((aid, i) => {
              const info = byArtifact.get(aid)!;
              const summary = summaryMap.get(aid);
              const summaryLine = summary
                ? `Summary: ${summary}`
                : `Preview: ${info.chunk_texts[0]?.slice(0, 500) || '(no preview)'}`;
              return `[${i + 1}] "${info.artifact_name}" (artifact_id=${aid}, relevance=${info.similarity.toFixed(2)})\n${summaryLine}`;
            }).join('\n\n');
            toolResults.push({
              tool: 'search_artifacts',
              pattern: query || undefined,
              success: true,
              output: `Found ${byArtifact.size} matching document(s). These are REAL user-uploaded documents — treat them as ground truth.\n\n${formatted}\n\n` +
                `⚡ NEXT STEP: To read the full content of any document above, use: ACTION: read_artifact / PARAM_ARTIFACT_ID: <id>. Do NOT re-run search_artifacts with different queries — drill down into these results instead.`,
              blocked: false,
              reasoning: plan.reasoning || 'Searched user artifacts via RAG',
            });
          } else {
            toolResults.push({
              tool: 'search_artifacts',
              pattern: query || undefined,
              success: true,
              output: 'No matching artifacts found. The user may not have uploaded documents related to this query.',
              blocked: false,
              reasoning: plan.reasoning || 'No artifacts matched',
            });
          }
          await this.events.publish('ToolCallStarted', sessionId, {
            tool: 'search_artifacts', query,
            iteration: iteration + 1, step_index: activeStepIndex,
            interaction_id: interactionId, client_message_id: clientMessageId,
          });
          await this.events.publish('ToolCallCompleted', sessionId, {
            tool: 'search_artifacts', success: results.length > 0,
            output: toolResults[toolResults.length - 1].output?.slice(0, 5000),
            output_length: toolResults[toolResults.length - 1].output?.length || 0,
            iteration: iteration + 1, step_index: activeStepIndex,
            interaction_id: interactionId, client_message_id: clientMessageId,
          });
          consecutiveDuplicates = 0;
          consecutiveFailures = 0;
          updateThoughtsOnlyStreak();
          continue;
        }

        // ── read_artifact (Level 2): fetch full transcript/content for a specific artifact ──
        if (toolName === 'read_artifact') {
          const artifactId = plan.artifact_id || plan.path || plan.pattern || '';
          this.logger.log(`read_artifact: artifact_id="${artifactId}"`);
          if (!artifactId) {
            toolResults.push({
              tool: 'read_artifact',
              success: false,
              output: 'Missing PARAM_ARTIFACT_ID. Use search_artifacts first to find artifact IDs, then call read_artifact with the specific artifact_id.',
              blocked: false,
              reasoning: plan.reasoning || 'No artifact ID provided',
            });
          } else {
            const artifact = await fetchArtifactById(artifactId);
            if (!artifact) {
              toolResults.push({
                tool: 'read_artifact',
                success: false,
                output: `Artifact "${artifactId}" not found. Use search_artifacts to find valid artifact IDs.`,
                blocked: false,
                reasoning: plan.reasoning || 'Artifact not found',
              });
            } else {
              const name = artifact.name || artifactId;
              const content = artifact.transcript || artifact.summary || '(no content available)';
              const MAX_CONTENT = 12000; // ~3000 tokens — generous but bounded
              const truncated = content.length > MAX_CONTENT
                ? content.slice(0, MAX_CONTENT) + `\n... [truncated at ${MAX_CONTENT} chars — full document is ${content.length} chars]`
                : content;
              toolResults.push({
                tool: 'read_artifact',
                success: true,
                output: `Full content of "${name}" (artifact_id=${artifactId}, ${content.length} chars):\n\n${truncated}`,
                blocked: false,
                reasoning: plan.reasoning || 'Retrieved full artifact content',
              });
            }
          }
          await this.events.publish('ToolCallStarted', sessionId, {
            tool: 'read_artifact', artifact_id: artifactId,
            iteration: iteration + 1, step_index: activeStepIndex,
            interaction_id: interactionId, client_message_id: clientMessageId,
          });
          await this.events.publish('ToolCallCompleted', sessionId, {
            tool: 'read_artifact', success: toolResults[toolResults.length - 1].success,
            output: toolResults[toolResults.length - 1].output?.slice(0, 5000),
            output_length: toolResults[toolResults.length - 1].output?.length || 0,
            iteration: iteration + 1, step_index: activeStepIndex,
            interaction_id: interactionId, client_message_id: clientMessageId,
          });
          consecutiveDuplicates = 0;
          consecutiveFailures = 0;
          updateThoughtsOnlyStreak();
          continue;
        }

        let resolvedBashWorktree: string | undefined;
        if (toolName === 'bash') {
          resolvedBashWorktree = coalesceDevAgentWorktreeId(plan.worktree_id, toolResults);
          if (commandLooksLikePackageInstall(command)) {
            if (!resolvedBashWorktree) {
              toolResults.push({
                tool: 'bash',
                command: command || undefined,
                success: false,
                output:
                  'Package installs (npm/pnpm/yarn/pip) must run inside a git worktree so changes stay on your agent branch. ' +
                  'Call create_worktree first (PARAM_NAME), then repeat bash with PARAM_WORKTREE_ID set to that id. ' +
                  'The dev-agent runs the shell with cwd = that worktree.',
                blocked: false,
                reasoning: plan.reasoning,
              });
              updateExplorationStateFromToolResult(
                toolResults[toolResults.length - 1],
                explorationState,
                semanticStructure,
                autonomousMode,
              );
              consecutiveFailures++;
              updateThoughtsOnlyStreak();
              continue;
            }
          }
        }

        // ── Guard: never create a second worktree if one already exists for this session
        if (toolName === 'create_worktree') {
          const existingWt =
            this._getSessionWorktreeId(sessionId) ||
            coalesceDevAgentWorktreeId(undefined, toolResults);
          if (existingWt) {
            // Ensure session map is populated even if we found it via toolResults
            this._setSessionWorktreeId(sessionId, existingWt);
            this.logger.log(
              `Skipping duplicate create_worktree — session ${sessionId} already has worktree: ${existingWt}`,
            );
            toolResults.push({
              tool: 'create_worktree',
              success: true,
              worktree_id: existingWt,
              output:
                `Worktree already exists: ${existingWt}. Reusing it. ` +
                `Use this worktree_id for all subsequent edit_file / write_file / apply_patch / bash calls.`,
              blocked: false,
              reasoning: 'Worktree reuse — no duplicate creation needed',
            });
            updateExplorationStateFromToolResult(
              toolResults[toolResults.length - 1],
              explorationState,
              semanticStructure,
              autonomousMode,
            );
            updateThoughtsOnlyStreak();
            continue;
          }
        }

        if (DEV_AGENT_TOOLS_NEED_WORKTREE.has(toolName)) {
          const wt =
            coalesceDevAgentWorktreeId(plan.worktree_id, toolResults) ||
            this._getSessionWorktreeId(sessionId);
          // Persist to session map if found via toolResults but not yet tracked
          if (wt && !this._getSessionWorktreeId(sessionId)) {
            this._setSessionWorktreeId(sessionId, wt);
          }
          if (!wt) {
            toolResults.push({
              tool: toolName,
              path: path || undefined,
              success: false,
              output:
                'Missing or invalid PARAM_WORKTREE_ID. Use the exact worktree id returned by create_worktree (e.g. feat-highlight or oasis-a1b2c3d4), not documentation text like "<from create_worktree>". ' +
                'If you have not called create_worktree yet in this session, call it first with PARAM_NAME: your-short-id, then retry with that id.',
              blocked: false,
              reasoning: plan.reasoning,
            });
            updateExplorationStateFromToolResult(
              toolResults[toolResults.length - 1],
              explorationState,
              semanticStructure,
              autonomousMode,
            );
            consecutiveFailures++;
            updateThoughtsOnlyStreak();
            continue;
          }
          plan.worktree_id = wt;
        }

        await this.events.publish('ToolCallStarted', sessionId, {
          tool: toolName,
          command: command || undefined,
          path: path || undefined,
          pattern: pattern || undefined,
          url: url || undefined,
          worktree_id: plan.worktree_id || plan.name || this._getSessionWorktreeId(sessionId) || undefined,
          reasoning: plan.reasoning || '',
          iteration: iteration + 1,
          step_index: activeStepIndex,
          plan_revision: planRevision,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });

        try {
          // Route to dev-agent (native host) or tool-executor (Docker) based on tool type
          let isDevAgentTool = DEV_AGENT_TOOLS.has(toolName);
          let targetUrl = isDevAgentTool
            ? `${DEV_AGENT_URL}/internal/dev-agent/execute`
            : `${TOOL_EXECUTOR_URL}/internal/tool/execute`;

          const execPayload: Record<string, any> = { tool: toolName };

          // AUTO-ROUTE: If agent uses read_file but we have a worktree, route to read_worktree_file
          // This prevents the confusion of having to switch tools manually
          const sessionWorktreeId = this._getSessionWorktreeId(sessionId);
          if (toolName === 'read_file' && sessionWorktreeId && !plan.worktree_id) {
            this.logger.log(`Auto-routing read_file to read_worktree_file using session worktree: ${sessionWorktreeId}`);
            execPayload.tool = 'read_worktree_file';
            execPayload.worktree_id = sessionWorktreeId;
            // Re-route to dev-agent since read_worktree_file is a dev-agent tool
            isDevAgentTool = true;
            targetUrl = `${DEV_AGENT_URL}/internal/dev-agent/execute`;
            const rawPath = path || '';
            const normalized = rawPath ? normalizeDevAgentFilePath(rawPath) || rawPath : '';
            execPayload.path = normalized ? repairAmbiguousDevPath(normalized) : undefined;
            if (plan.start_line != null) execPayload.start_line = Number(plan.start_line);
            if (plan.end_line != null) execPayload.end_line = Number(plan.end_line);
          } else if (isDevAgentTool) {
            // Dev-agent tools use worktree_id, path, content, old_string, new_string, name
            execPayload.name = plan.name || plan.worktree_id || undefined;
            const pathNeedsWorktreeRoot =
              toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_worktree_file';
            const rawPath = path || '';
            const normalized = rawPath ? normalizeDevAgentFilePath(rawPath) || rawPath : '';
            const devAgentPath = normalized ? repairAmbiguousDevPath(normalized) : '';
            execPayload.path = pathNeedsWorktreeRoot ? devAgentPath || undefined : undefined;
            // Use ?? not || — empty string is valid for new_string (delete matched text) and for write_file content.
            // Strip smart/curly quotes — LLMs emit them in code, breaking syntax.
            execPayload.content = stripSmartQuotes(plan.content ?? undefined);
            execPayload.old_string = stripSmartQuotes(plan.old_string ?? undefined);
            execPayload.new_string = stripSmartQuotes(plan.new_string ?? undefined);
            if (toolName === 'apply_patch') {
              execPayload.patch = stripSmartQuotes(plan.patch ?? undefined);
            }
            if (toolName === 'bash') {
              execPayload.command = stripSmartQuotes(command) || undefined;
              execPayload.worktree_id = resolvedBashWorktree || undefined;
            } else if (toolName === 'computer_action') {
              // Computer-use: pass action + coordinates + text/key params
              execPayload.action = plan.action || plan.computer_action || undefined;
              execPayload.x = plan.x != null ? Number(plan.x) : undefined;
              execPayload.y = plan.y != null ? Number(plan.y) : undefined;
              execPayload.text = plan.text ?? undefined;
              execPayload.key = plan.key ?? undefined;
              execPayload.keys = plan.keys ?? undefined;
              execPayload.button = plan.button ?? undefined;
              execPayload.direction = plan.direction ?? undefined;
              execPayload.amount = plan.amount != null ? Number(plan.amount) : undefined;
              execPayload.clicks = plan.clicks != null ? Number(plan.clicks) : undefined;
            } else {
              // Auto-resolve worktree_id: use plan's value, fall back to session worktree,
              // then fall back to last successful create_worktree in tool results.
              // This prevents "missing worktree" failures when the LLM forgets worktree_id
              // (common after slice(-5) truncation drops the create_worktree result).
              const resolvedWorktreeId =
                plan.worktree_id ||
                this._getSessionWorktreeId(sessionId) ||
                coalesceDevAgentWorktreeId(undefined, toolResults);
              execPayload.worktree_id = resolvedWorktreeId || undefined;
              if (!plan.worktree_id && resolvedWorktreeId) {
                this.logger.log(`Auto-resolved worktree_id for ${toolName}: ${resolvedWorktreeId}`);
              }
              // Chunked read support for read_worktree_file
              if (toolName === 'read_worktree_file') {
                if (plan.start_line != null) execPayload.start_line = Number(plan.start_line);
                if (plan.end_line != null) execPayload.end_line = Number(plan.end_line);
              }
            }
          } else {
            execPayload.command = command || undefined;
            execPayload.path = path || undefined;
            execPayload.pattern = plan.pattern || undefined;
            execPayload.url = url || undefined;
            // list_dir recursive mode
            if (plan.recursive) execPayload.recursive = true;
            // find_files file_type filter
            if (plan.file_type) execPayload.file_type = plan.file_type;
            // Chunked read support for read_file
            if (toolName === 'read_file') {
              if (plan.start_line != null) execPayload.start_line = Number(plan.start_line);
              if (plan.end_line != null) execPayload.end_line = Number(plan.end_line);
            }
          }

          const execTimeoutMs =
            toolName === 'bash' ? 600_000 : toolName === 'apply_patch' ? 180_000 : 45_000;
          let execRes = await axiosWithRetry('post', targetUrl, execPayload, undefined, { timeout: execTimeoutMs });

          let result = execRes.data;

          // ── Auto-recover from stale/deleted worktree ──────────────────
          // If the dev-agent says the worktree doesn't exist, create a new
          // one on the fly and retry the exact same tool call.
          if (
            !result.success &&
            isDevAgentTool &&
            typeof result.output === 'string' &&
            /worktree.*not found/i.test(result.output) &&
            execPayload.worktree_id
          ) {
            const staleId = execPayload.worktree_id;
            this.logger.warn(`Worktree '${staleId}' was deleted externally — auto-creating replacement`);
            try {
              const createRes = await axiosWithRetry('post', `${DEV_AGENT_URL}/internal/dev-agent/execute`, {
                tool: 'create_worktree',
                name: `recover-${Date.now().toString(36)}`,
              }, undefined, { timeout: 30_000 });
              if (createRes.data?.success && createRes.data?.worktree_id) {
                const newWt = createRes.data.worktree_id;
                this._setSessionWorktreeId(sessionId, newWt);
                this.logger.log(`Replacement worktree created: ${newWt} (was: ${staleId})`);
                // Inject a synthetic create_worktree result so the LLM sees it
                toolResults.push({
                  tool: 'create_worktree',
                  success: true,
                  worktree_id: newWt,
                  output: `Previous worktree '${staleId}' was deleted. New worktree '${newWt}' created automatically. Using it for all subsequent calls.`,
                  blocked: false,
                  reasoning: 'System: auto-recovered from deleted worktree',
                });
                // Retry the original tool call with the new worktree_id
                execPayload.worktree_id = newWt;
                execRes = await axiosWithRetry('post', targetUrl, execPayload, undefined, { timeout: execTimeoutMs });
                result = execRes.data;
              }
            } catch (recoverErr: any) {
              this.logger.error(`Worktree auto-recovery failed: ${recoverErr.message}`);
            }
          }

          if (result.blocked) {
            await this.events.publish('ToolCallBlocked', sessionId, {
              tool: toolName,
              command: command || undefined,
              path: path || undefined,
              reason: result.reason,
              iteration: iteration + 1,
              step_index: activeStepIndex,
              plan_revision: planRevision,
              interaction_id: interactionId,
              client_message_id: clientMessageId,
            });
          }

          const completedPayload: Record<string, any> = {
            tool: toolName,
            success: result.success,
            blocked: result.blocked,
            output: (result.output || '').slice(0, 5000),
            output_length: (result.output || '').length,
            iteration: iteration + 1,
            step_index: activeStepIndex,
            plan_revision: planRevision,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          };
          // Include diff/worktree data for UI diff viewer
          if (result.diff) completedPayload.diff = result.diff;
          if (result.worktree_id) completedPayload.worktree_id = result.worktree_id;
          if (result.files_changed) completedPayload.files_changed = result.files_changed;

          await this.events.publish('ToolCallCompleted', sessionId, completedPayload);

          const trEntry: Record<string, any> = {
            tool: toolName,
            command: command || undefined,
            path: path || undefined,
            pattern: pattern || undefined,
            url: url || undefined,
            success: result.success,
            output: result.output || '',
            blocked: result.blocked || false,
            reasoning: plan.reasoning,
            recursive: plan.recursive || false,
            start_line: plan.start_line != null ? Number(plan.start_line) : undefined,
            end_line: plan.end_line != null ? Number(plan.end_line) : undefined,
          };
          const wid = result.worktree_id || (toolName === 'bash' ? execPayload.worktree_id : undefined);
          if (wid) {
            trEntry.worktree_id = wid;
            // Track worktree_id for this session to enable auto-routing
            if (toolName === 'create_worktree' && result.success) {
              this._setSessionWorktreeId(sessionId, wid);
              this.logger.log(`Session ${sessionId} now has worktree: ${wid}`);
            }
          }
          if (result.read_metadata && (toolName === 'read_file' || toolName === 'read_worktree_file')) {
            trEntry.read_metadata = result.read_metadata as ReadFileMetadata;
          }
          toolResults.push(trEntry as (typeof toolResults)[number]);
          updateExplorationStateFromToolResult(
            toolResults[toolResults.length - 1],
            explorationState,
            semanticStructure,
            autonomousMode,
          );
          const newWalls = extractWallsFromToolResults(toolResults);
          wallsHit.length = 0;
          wallsHit.push(...newWalls);

          // Post-read nudge: full-file read did not return the entire file (line cap, byte cap, or legacy footer).
          // Prefer read_metadata from tool-executor/dev-agent (file_size vs returned_bytes) over regex on the body.
          const rm = result.read_metadata as ReadFileMetadata | undefined;
          const fullReadNoRange = plan.start_line == null;
          const rawReadOut = typeof result.output === 'string' ? result.output : '';
          const legacyLineTrunc = /truncated at \d+ of \d+ lines/.test(rawReadOut);
          const metaTrunc = Boolean(rm?.truncated_by_line_cap) || Boolean(rm?.truncated_by_byte_cap);
          const truncatedFullRead =
            result.success &&
            (toolName === 'read_file' || toolName === 'read_worktree_file') &&
            fullReadNoRange &&
            (metaTrunc || legacyLineTrunc);
          if (truncatedFullRead) {
            const totalLineCount = rm?.total_lines ?? Number(rawReadOut.match(/truncated at \d+ of (\d+) lines/)?.[1]);
            const totalLinesStr = Number.isFinite(totalLineCount) ? String(totalLineCount) : '500+';
            const nextStart = rm?.next_chunk_start_line ?? 501;
            const totalN = Number.isFinite(totalLineCount) ? totalLineCount : null;
            const nextEnd = totalN != null ? Math.min(nextStart + 499, totalN) : nextStart + 499;
            const byteOnly =
              Boolean(rm?.truncated_by_byte_cap) &&
              !rm?.truncated_by_line_cap &&
              !legacyLineTrunc;
            this.logger.warn(
              `Full-file read incomplete (${totalLinesStr} lines, byte_cap=${Boolean(rm?.truncated_by_byte_cap)}, line_cap=${Boolean(rm?.truncated_by_line_cap)}) — nudging chunked reads`,
            );
            const chunkHint = byteOnly
              ? `Output hit the size cap (${rm?.returned_bytes ?? '?'} of ${rm?.file_size_bytes ?? '?'} bytes on disk). Use start_line/end_line to read a smaller slice, or grep for a symbol then read ±20 lines around the match.`
              : `If you need more of the file, immediately read the next chunk: ${toolName || 'read_file'} path=${path || '...'} start_line=${nextStart} end_line=${nextEnd}.`;
            toolResults.push({
              tool: '_system',
              success: true,
              output:
                `⚠️ FILE READ INCOMPLETE: ${path || '(file)'} — ${totalLinesStr} lines total; output was truncated (see tool read_metadata: file_size_bytes vs returned_bytes). ` +
                `DO NOT STOP. DO NOT ask the user what to focus on. ` +
                chunkHint +
                ` If you only need a specific section, use grep first, then read ±15 lines around the match.`,
              blocked: false,
              reasoning: 'System: full-file read truncated — enforce chunked reads',
            });
          }

          // Track consecutive failures and force teaching
          consecutiveDuplicates = 0; // non-duplicate call executed — reset streak
          if (!result.success || result.blocked) {
            consecutiveFailures++;
          } else {
            consecutiveFailures = 0;
          }

          // Patch/edit-specific: immediate retry nudge on FIRST failure
          if (
            !result.success &&
            consecutiveFailures === 1 &&
            (toolName === 'apply_patch' || toolName === 'edit_file')
          ) {
            const targetPath = path || '(unknown file)';
            const errOutput = (result.output || '').slice(0, 200);
            toolResults.push({
              tool: '_system',
              success: true,
              output:
                `⚠️ ${toolName} FAILED on ${targetPath}: ${errOutput}\n` +
                `FIX IT NOW — do NOT give up or move on:\n` +
                `  1. read_worktree_file path=${targetPath} with start_line/end_line around the area you're editing\n` +
                `  2. COPY the exact lines from the read output — do NOT type from memory\n` +
                `  3. Regenerate the patch/edit with correct content and retry immediately`,
              blocked: false,
              reasoning: 'System: immediate retry nudge after first patch/edit failure',
            });
          }

          // Patch/edit-specific escalation: after 2 consecutive failures on same tool, force strategy switch
          if (
            !result.success &&
            consecutiveFailures >= 2 &&
            (toolName === 'apply_patch' || toolName === 'edit_file')
          ) {
            const recentPatchFails = toolResults
              .slice(-consecutiveFailures)
              .filter(r => !r.success && (r.tool === 'apply_patch' || r.tool === 'edit_file'));
            if (recentPatchFails.length >= 2) {
              const targetPath = path || recentPatchFails[0]?.path || '?';
              const failedTool = recentPatchFails[recentPatchFails.length - 1]?.tool || toolName;
              const alt = failedTool === 'apply_patch' ? 'edit_file' : 'apply_patch';
              toolResults.push({
                tool: '_system',
                success: true,
                output:
                  `⚠️ PATCH/EDIT FAILED ${recentPatchFails.length}x on ${targetPath}. STOP. Your diff/old_string is wrong.\n` +
                  `MANDATORY recovery:\n` +
                  `  1. read_worktree_file with TIGHT start_line/end_line (only the ~20 lines around your change)\n` +
                  `  2. COPY context lines EXACTLY from read output — do not type from memory\n` +
                  `  3. Make a SMALL patch (one hunk, ≤30 lines) — do NOT combine multiple changes\n` +
                  `  4. If ${failedTool} keeps failing → switch to ${alt}\n` +
                  `  5. For single-line changes, prefer edit_file with a short unique old_string`,
                blocked: false,
                reasoning: 'System: forced strategy switch after repeated patch/edit failures',
              });
            }
          }

          if (autonomousMode && consecutiveFailures >= 2 && !teachingForced) {
            teachingForced = true;
            const failedTools = toolResults.slice(-consecutiveFailures).map(r => `${r.tool}(${r.path || r.pattern || r.command || ''})`).join(', ');
            toolResults.push({
              tool: '_system',
              success: true,
              output: `⚠️ TEACHING REQUIRED: You have ${consecutiveFailures} consecutive failures (${failedTools}). You MUST now output a teach_rule action to record what you learned from these failures BEFORE making another tool call. Example: {"action": "teach_rule", "condition": "IF searching for <what you assumed>", "conclusion": "THEN <what you learned is actually correct>", "reasoning": "discovered through failed searches"}. After teaching, change your strategy completely.`,
              blocked: false,
              reasoning: 'System: forced teaching after consecutive failures',
            });
          } else if (consecutiveFailures === 0) {
            teachingForced = false;  // Reset so teaching can be forced again on next failure streak
          }
        } catch (err: any) {
          this.logger.warn(`Tool executor call failed: ${err.message}`);
          consecutiveFailures++;
          toolResults.push({
            tool: toolName,
            command: command || undefined,
            path: path || undefined,
            pattern: pattern || undefined,
            url: url || undefined,
            success: false,
            output: `Tool executor error: ${err.message}`,
            blocked: false,
            reasoning: plan.reasoning,
          });
          updateExplorationStateFromToolResult(
            toolResults[toolResults.length - 1],
            explorationState,
            semanticStructure,
            autonomousMode,
          );
          const newWalls = extractWallsFromToolResults(toolResults);
          wallsHit.length = 0;
          wallsHit.push(...newWalls);
          if (autonomousMode && consecutiveFailures >= 2 && !teachingForced) {
            teachingForced = true;
            toolResults.push({
              tool: '_system',
              success: true,
              output: `⚠️ TEACHING REQUIRED: ${consecutiveFailures} consecutive failures. You MUST output a teach_rule action NOW to record what you learned, then try a completely different approach.`,
              blocked: false,
              reasoning: 'System: forced teaching after consecutive failures',
            });
          }

          await this.events.publish('ToolCallCompleted', sessionId, {
            tool: toolName,
            success: false,
            error: err.message,
            iteration: iteration + 1,
            step_index: activeStepIndex,
            plan_revision: planRevision,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
        }
      }

      // If we reached here, we executed a tool/teaching action and did not hit any early `continue`.
      // Update thought-only streak for this iteration now.
      updateThoughtsOnlyStreak();

      // 3. Observer validates — if goal met, exit loop and summarize
      try {
        const obsRes = await axiosWithRetry('post', `${OBSERVER_URL}/internal/observer/validate`, {
          user_goal: semanticStructure?.problem || req.user_message,
          semantic_structure: semanticStructure,
          task_graph: taskGraph,
          tool_results: toolResults,
          plan: upfrontPlan,
          session_id: sessionId,
          memory_context: memoryContext,
          rules,
          memory_stale_hint: memoryStaleHint,
          validated_thoughts: validatedThoughts.length > 0 ? validatedThoughts : undefined,
        }, undefined, { timeout: OBSERVER_VALIDATE_TIMEOUT_MS });
        taskGraph = obsRes.data.updated_graph || taskGraph;

        // Apply validated thoughts to taskGraph
        if (taskGraph && taskGraph.nodes && validatedThoughts.length > 0) {
          const graph = taskGraph;
          const actionNodes = graph.nodes.filter((n: any) => n.node_type === 'ActionNode' || n.node_type === 'Action');
          const lastActionNode = actionNodes[actionNodes.length - 1];
          
          validatedThoughts.forEach((t) => {
            const tNodeId = uuidv4();
            graph.nodes.push({
              id: tNodeId,
              node_type: 'ThoughtNode',
              title: t.thought.substring(0, 50),
              confidence: t.confidence,
              source: 'system',
              attributes: { thought: t.thought, rationale: t.rationale, confidence: t.confidence, validated: true },
            });
            if (lastActionNode) {
              if (!graph.edges) graph.edges = [];
              graph.edges.push({
                source_node: tNodeId,
                target_node: lastActionNode.id,
                edge_type: 'INFORMS',
                weight: 1.0,
              });
            }
          });
        }

        // Store task graph + walls to memory after every observer validation (always, not only when walls exist)
        if (taskGraph && Object.keys(taskGraph).length > 0) {
          try {
            await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/store`, {
              reasoning_graph: taskGraph,
              user_id: 'default',
              session_id: sessionId,
              walls: wallsHit.length > 0 ? wallsHit : undefined,
            }, undefined, { timeout: FAST_TIMEOUT_MS });
            const conclusion = obsRes.data.goal_met ? 'Goal met' : `Goal not met: ${obsRes.data.feedback || 'Continue working on the task.'}`;
            const reasoningTrace = [
              `Route: tool_use`,
              `Observer: ${obsRes.data.goal_met ? 'Goal met' : 'Goal not met'}`,
              ...toolResults.slice(-3).map((r: any, i: number) => `  #${toolResults.length - 3 + i + 1} ${r.tool}: ${r.success ? 'OK' : r.blocked ? 'BLOCKED' : 'FAILED'}`),
            ];
            await this.events.publish('TaskGraphUpdated', sessionId, {
              session_id: sessionId,
              client_message_id: clientMessageId,
              task_graph: taskGraph,
              conclusion,
              confidence: obsRes.data.confidence ?? 0.5,
              reasoning_trace: reasoningTrace,
            });
            // Re-fetch memory AND rules so next tool-plan uses the latest state,
            // then run logic engine to update reasoning with current rules
            try {
              const [memRes, rulesRefresh] = await Promise.all([
                axiosWithRetry('get', `${MEMORY_URL}/internal/memory/query`, {
                  params: { q: semanticStructure?.problem || req.user_message, limit: 5, session_id: sessionId },
                }, undefined, { timeout: FAST_TIMEOUT_MS }),
                axiosWithRetry('get', `${MEMORY_URL}/internal/memory/rules`, undefined, undefined, { timeout: FAST_TIMEOUT_MS, retries: 1 }),
              ]);
              memoryContext = memRes.data.results || [];
              rules = rulesRefresh.data.rules || rules;

              // Update logic engine with refreshed rules + task graph
              if (autonomousMode && taskGraph && Object.keys(taskGraph).length > 0) {
                try {
                  const logicRes = await axiosWithRetry('post', `${LOGIC_ENGINE_URL}/internal/reason`, {
                    reasoning_graph: taskGraph,
                    memory_context: memoryContext,
                    memory_stale_hint: memoryStaleHint,
                  }, undefined, { timeout: FAST_TIMEOUT_MS });
                  // Merge logic engine insights into observer feedback
                  const logicConclusion = logicRes.data?.decision_tree?.conclusion;
                  const logicConfidence = logicRes.data?.confidence;
                  if (logicConclusion) {
                    observerFeedback = (observerFeedback || '') +
                      `\n[Logic Engine update: ${logicConclusion} (confidence: ${logicConfidence?.toFixed?.(2) ?? '?'})]`;
                  }
                } catch {
                  // logic engine update is best-effort
                }
              }
            } catch {
              // best-effort
            }
          } catch {
            // best-effort
          }
        }
        if (obsRes.data.goal_met) {
          this.logger.log('Observer validated goal met — completing');
          // Task graph already stored at line above (every observer validation stores it).
          // No duplicate store needed here.
          let responseText = '';
          try {
            const sumRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/response/tool-summarize`, {
              user_message: req.user_message,
              tool_results: toolResults,
            }, undefined, { timeout: LLM_TIMEOUT_MS });
            responseText = sumRes.data.response_text || 'Done.';
          } catch {
            responseText = toolResults.map((r, i) => `#${i + 1} [${r.tool}] ${r.success ? 'OK' : 'FAILED'}: ${(r.output || '').slice(0, 200)}`).join('\n');
          }
          await this.events.publish('ToolUseComplete', sessionId, {
            tool_calls: toolResults.length,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
          await this.events.publish('ResponseGenerated', sessionId, {
            response_length: responseText.length,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
          toolSpan?.end({ output: { tool_calls: toolResults.length } });
          trace?.update({ output: { response: responseText, route: 'tool_use' } });
          const conclusion = obsRes.data.goal_met ? 'Goal met' : `Goal not met: ${obsRes.data.feedback || ''}`;
          return {
            session_id: sessionId,
            response: responseText,
            reasoning_graph: taskGraph || {},
            confidence: obsRes.data.confidence ?? 1.0,
            reasoning_trace: [
              `Route: tool_use`,
              `Tool calls: ${toolResults.length}`,
              ...toolResults.map((r, i) => `  #${i + 1} ${r.tool}: ${r.command || r.path || r.url || '?'} → ${r.success ? 'OK' : r.blocked ? 'BLOCKED' : 'FAILED'}`),
            ],
            conclusion,
            route: 'tool_use',
          };
        }
        const baseObsFb = obsRes.data.feedback || 'Continue working on the task.';
        if (!obsRes.data.goal_met && obsRes.data.revise_plan) {
          const replanned = await runObserverReplan(baseObsFb, iteration);
          observerFeedback = replanned
            ? `${baseObsFb}\n[SYSTEM: The upfront plan was revised. Execute from step 1 of the new plan — follow the updated Execution plan in the UI.]`
            : baseObsFb;
        } else {
          observerFeedback = baseObsFb;
        }
      } catch (obsErr: any) {
        this.logger.warn(`Observer validate failed: ${obsErr.message} — continuing`);
        observerFeedback = 'Observer unavailable. If you have exhausted options, explain to the user and give final_answer.';
      }
    }

    // Max iterations or time limit reached — summarize what we have
    this.logger.warn(maxDurationReached ? 'Autonomous mode: time limit reached' : 'Tool use max iterations reached');
    await this.events.publish('ToolUseComplete', sessionId, {
      tool_calls: toolResults.length,
      max_iterations_reached: !maxDurationReached,
      max_duration_reached: maxDurationReached,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });

    // Store task graph + walls so future sessions avoid same mistakes
    if (taskGraph && Object.keys(taskGraph).length > 0) {
      try {
        await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/store`, {
          reasoning_graph: taskGraph,
          user_id: 'default',
          session_id: sessionId,
          walls: wallsHit.length > 0 ? wallsHit : undefined,
        }, undefined, { timeout: FAST_TIMEOUT_MS });
      } catch {
        // store is best-effort
      }
    }

    let responseText = '';
    try {
      const sumRes = await axiosWithRetry('post', `${RESPONSE_URL}/internal/response/tool-summarize`, {
        user_message: req.user_message,
        tool_results: toolResults,
      }, undefined, { timeout: LLM_TIMEOUT_MS });
      responseText = sumRes.data.response_text || (maxDurationReached
        ? `I ran for ${sessionCfg.autonomous_max_duration_hours} hours (autonomous mode time limit).`
        : 'I ran several commands but reached the iteration limit.');
    } catch {
      responseText = 'I executed some tools but had trouble summarizing the results. Here is what I found:\n\n' +
        toolResults.map((r, i) => `#${i + 1} [${r.tool}] ${r.success ? 'OK' : 'FAILED'}: ${(r.output || '').slice(0, 500)}`).join('\n');
    }

    await this.events.publish('ResponseGenerated', sessionId, {
      response_length: responseText.length,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });

    toolSpan?.end({ output: { tool_calls: toolResults.length, max_iterations: true } });
    trace?.update({ output: { response: responseText, route: 'tool_use' } });

    return {
      session_id: sessionId,
      response: responseText,
      reasoning_graph: taskGraph || {},
      confidence: 1.0,
      reasoning_trace: [
        `Route: tool_use (max iterations)`,
        `Tool calls: ${toolResults.length}`,
        ...toolResults.map((r, i) => `  #${i + 1} ${r.tool}: ${r.command || r.path || r.url || '?'} → ${r.success ? 'OK' : r.blocked ? 'BLOCKED' : 'FAILED'}`),
      ],
      route: 'tool_use',
    };
  }

  // ── TEACHING: validate assertion → web search → clarifying questions ──
  private async handleTeaching(
    sessionId: string,
    req: InteractionRequest,
    semanticStructure: any,
    trace: any,
    interactionId: string,
    clientMessageId: string | undefined,
  ): Promise<InteractionResponse> {
    this.logger.log('Teaching route — validate + search + clarify');

    // 1. Call teaching service to extract & validate assertion
    const teachSpan = trace?.span({ name: 'teaching-validate', input: { text: req.user_message } });
    const llmStart = Date.now();
    await this.events.publish('LlmCallStarted', sessionId, {
      service: 'teaching-service',
      route: 'teaching',
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });
    const teachRes = await axiosWithRetry('post', `${TEACHING_URL}/internal/teaching/validate`, {
      user_message: req.user_message,
      semantic_structure: semanticStructure,
    }, undefined, { timeout: LLM_TIMEOUT_MS });
    await this.events.publish('LlmCallCompleted', sessionId, {
      service: 'teaching-service',
      route: 'teaching',
      duration_ms: Date.now() - llmStart,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });
    const assertion = teachRes.data.assertion;
    const searchQuery = teachRes.data.search_query || '';
    const validation = teachRes.data.validation;
    teachSpan?.end({ output: { assertion: assertion.assertion, confidence: validation.confidence, contradictions: validation.contradictions?.length || 0 } });

    await this.events.publish('TeachingValidationComplete', sessionId, {
      assertion: assertion.assertion,
      confidence: validation.confidence,
      has_contradictions: validation.contradictions?.length > 0,
      interaction_id: interactionId,
      client_message_id: clientMessageId,
    });

    // 2. Build response based on validation results
    let responseText = '';
    const questions: string[] = validation.clarifying_questions || [];

    const readyToStore =
      Boolean(validation.is_validated) &&
      (validation.confidence ?? 0) >= 0.6 &&
      (validation.contradictions?.length || 0) === 0;

    // Keep pending until we can store — not only when the model emitted a question (otherwise
    // follow-up replies never re-enter this flow).
    if (!readyToStore) {
      try {
        await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/teaching/pending`, {
          session_id: sessionId,
          assertion,
          search_query: searchQuery,
          validation,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });
      } catch {
        // optional
      }
    } else {
      await this.clearPendingTeaching(sessionId);
    }

    if (validation.contradictions && validation.contradictions.length > 0) {
      // Found contradictions — ask user to clarify
      responseText = `I looked into "${assertion.assertion}" and found some nuances worth discussing.\n\n`;
      responseText += `**What I found:** ${validation.summary}\n\n`;
      if (validation.contradictions.length > 0) {
        responseText += `**Potential contradictions:**\n`;
        for (const c of validation.contradictions) {
          responseText += `- ${c}\n`;
        }
        responseText += '\n';
      }
      if (questions.length > 0) {
        responseText += `**To help me learn this correctly, could you clarify:**\n`;
        for (const q of questions) {
          responseText += `- ${q}\n`;
        }
      }
    } else if (readyToStore) {
      // Validated — store it
      const isCodebaseSpecific = assertion.is_codebase_specific || assertion.category === 'codebase_knowledge';
      const atomicRules: string[] = assertion.atomic_rules?.length > 0 ? assertion.atomic_rules : [assertion.assertion];

      if (isCodebaseSpecific) {
        // Codebase-specific knowledge → store in Knowledge Graph (memory), NOT as rules
        try {
          await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/store`, {
            reasoning_graph: {
              id: `teaching-${Date.now()}`,
              session_id: sessionId,
              nodes: [{
                id: `teach-${Date.now()}`,
                node_type: 'conclusion',
                title: assertion.assertion,
                description: assertion.supporting_context || '',
                confidence: validation.confidence,
                source: 'user',
                attributes: { category: assertion.category, domain: assertion.domain },
              }],
              edges: [],
            },
            user_id: 'default',
            session_id: sessionId,
          }, undefined, { timeout: FAST_TIMEOUT_MS });
          await this.events.publish('TeachingKnowledgeStored', sessionId, {
            assertion: assertion.assertion,
            confidence: validation.confidence,
            stored_as: 'knowledge_graph',
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
        } catch {
          this.logger.warn('Failed to store codebase knowledge in memory');
        }
        responseText = `Got it! I've stored this as **codebase knowledge** (Knowledge Graph): "${assertion.assertion}"\n\n`;
        responseText += `This is project-specific, so it's stored in the Knowledge Graph rather than as a general rule.\n`;
        responseText += `Confidence: ${Math.round(validation.confidence * 100)}%`;
      } else {
        // General ground truth → store each atomic rule individually
        try {
          for (const rule of atomicRules) {
            await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/teach`, {
              assertion: rule,
              category: assertion.category,
              domain: assertion.domain,
              confidence: validation.confidence,
              supporting_sources: validation.web_sources?.slice(0, 3) || [],
              underlying_concept: validation.underlying_concept || '',
            });
          }
          await this.events.publish('TeachingKnowledgeStored', sessionId, {
            assertion: assertion.assertion,
            atomic_rules: atomicRules,
            rule_count: atomicRules.length,
            confidence: validation.confidence,
            stored_as: 'rules',
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          });
        } catch {
          this.logger.warn('Failed to store teaching in memory');
        }

        if (atomicRules.length > 1) {
          responseText = `Got it! I've decomposed this into ${atomicRules.length} atomic rules:\n\n`;
          for (const rule of atomicRules) {
            responseText += `- "${rule}"\n`;
          }
          responseText += `\n${validation.summary}\n`;
        } else {
          responseText = `Got it! I've learned: "${assertion.assertion}"\n\n`;
          responseText += `${validation.summary}\n`;
        }
        responseText += `Confidence: ${Math.round(validation.confidence * 100)}%`;
        if (validation.underlying_concept) {
          responseText += `\nUnderlying principle: ${validation.underlying_concept}`;
        }
      }
      if (questions.length > 0) {
        const q = questions[0];
        responseText += `\n\n**I'd also like to understand one thing:**\n`;
        responseText += `- ${q}\n`;
      }
    } else {
      // Low confidence — need more context
      responseText = `I want to understand this teaching better before I store it.\n\n`;
      responseText += `Here's what I understood from your message:\n`;
      responseText += `"${assertion.assertion}"\n`;
      if (validation.summary) {
        responseText += `\n${validation.summary}\n\n`;
      }
      if (questions.length > 0) {
        const q = questions[0];
        responseText += `**Could you help me refine this?**\n`;
        responseText += `- ${q}\n`;
      } else {
        responseText += `Could you provide more context or clarify how you'd like this rule to work?`;
      }
    }

    // Include web sources in trace
    const webSourcesSummary = (validation.web_sources || []).slice(0, 3).map((s: any) => s.title);

    trace?.update({ output: { response: responseText, route: 'teaching', validated: validation.is_validated, confidence: validation.confidence } });

    return {
      session_id: sessionId,
      response: responseText,
      reasoning_graph: {},
      confidence: validation.confidence || 0,
      reasoning_trace: [
        `Route: teaching`,
        `Assertion: ${assertion.assertion}`,
        `Category: ${assertion.category} | Domain: ${assertion.domain}`,
        `Web sources checked: ${webSourcesSummary.join(', ') || 'none'}`,
        `Contradictions: ${validation.contradictions?.length || 0}`,
        `Validated: ${validation.is_validated} (confidence: ${validation.confidence})`,
      ],
      route: 'teaching',
      clarifying_questions: questions,
    };
  }

  private async handleTeachingFollowup(
    sessionId: string,
    req: InteractionRequest,
    pending: any,
    trace: any,
    interactionId: string,
    clientMessageId: string | undefined,
  ): Promise<InteractionResponse> {
    this.logger.log('Teaching follow-up — continuing pending validation');

    const contSpan = trace?.span({ name: 'teaching-continue', input: { text: req.user_message } });
    const teachRes = await axiosWithRetry('post', `${TEACHING_URL}/internal/teaching/continue`, {
      user_message: req.user_message,
      assertion: pending.assertion || {},
      search_query: pending.search_query || '',
      prior_validation: pending.validation || null,
    }, undefined, { timeout: LLM_TIMEOUT_MS });
    const assertion = teachRes.data.assertion;
    const searchQuery = teachRes.data.search_query || pending.search_query || '';
    const validation = teachRes.data.validation;
    contSpan?.end({ output: { assertion: assertion.assertion, confidence: validation.confidence } });

    const questions: string[] = validation.clarifying_questions || [];

    const readyToStore =
      Boolean(validation.is_validated) &&
      (validation.confidence ?? 0) >= 0.6 &&
      (validation.contradictions?.length || 0) === 0;

    if (!readyToStore) {
      try {
        await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/teaching/pending`, {
          session_id: sessionId,
          assertion,
          search_query: searchQuery,
          validation,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });
      } catch {
        // optional
      }
    } else {
      await this.clearPendingTeaching(sessionId);
    }

    // If validated now, store it like the normal teaching route.
    let responseText = '';
    if (readyToStore) {
      try {
        await axiosWithRetry('post', `${MEMORY_URL}/internal/memory/teach`, {
          assertion: assertion.assertion,
          category: assertion.category,
          domain: assertion.domain,
          confidence: validation.confidence,
          supporting_sources: validation.web_sources?.slice(0, 3) || [],
          underlying_concept: validation.underlying_concept || '',
        });
        await this.events.publish('TeachingKnowledgeStored', sessionId, {
          assertion: assertion.assertion,
          confidence: validation.confidence,
          interaction_id: interactionId,
          client_message_id: clientMessageId,
        });
      } catch {
        this.logger.warn('Failed to store teaching in memory');
      }

      responseText = `Got it! I've learned: "${assertion.assertion}"\n\n`;
      responseText += `${validation.summary}\n`;
      responseText += `Confidence: ${Math.round(validation.confidence * 100)}%`;
      if (validation.underlying_concept) {
        responseText += `\nUnderlying principle: ${validation.underlying_concept}`;
      }
    } else {
      responseText = `Thanks — I still want to be precise before I store this.\n\n`;
      responseText += `You said: "${assertion.assertion}"\n`;
      if (validation.summary) {
        responseText += `${validation.summary}\n\n`;
      }
      if (questions.length > 0) {
        responseText += `**Could you clarify:**\n`;
        for (const q of questions) {
          responseText += `- ${q}\n`;
        }
      }
    }

    trace?.update({ output: { response: responseText, route: 'teaching', validated: validation.is_validated, confidence: validation.confidence } });

    return {
      session_id: sessionId,
      response: responseText,
      reasoning_graph: {},
      confidence: validation.confidence || 0,
      reasoning_trace: [
        `Route: teaching (follow-up)`,
        `Assertion: ${assertion.assertion}`,
        `Validated: ${validation.is_validated} (confidence: ${validation.confidence})`,
      ],
      route: 'teaching',
      clarifying_questions: questions,
    };
  }

  private async generateStreamingThoughts(
    sessionId: string,
    userMessage: string,
    context: any,
    chatHistory: any[],
    interactionId: string,
    clientMessageId: string | undefined,
    toolResults?: any[],
    observerFeedback?: string | null,
  ): Promise<string> {
    let fullThoughts = '';
    const responseUrl = process.env.RESPONSE_URL || 'http://response-generator:8005';
    try {
      this.logger.log(`Starting streaming thoughts for session ${sessionId}`);
      const response = await axios({
        method: 'post',
        url: `${responseUrl}/internal/thought/reason-stream`,
        data: {
          user_message: userMessage,
          context,
          chat_history: chatHistory?.length > 0 ? chatHistory : undefined,
          tool_results: toolResults,
          observer_feedback: observerFeedback,
        },
        responseType: 'stream',
        timeout: LLM_TIMEOUT_MS,
      });

      const stream = response.data;
      const MAX_THOUGHT_CHARS = 3000; // hard cap — thoughts should be concise
      let aborted = false;

      return new Promise((resolve) => {
        stream.on('data', (chunk: Buffer) => {
          if (aborted) return;
          const text = chunk.toString();
          fullThoughts += text;

          // Guard: abort if thoughts exceed char limit (hallucination/runaway)
          if (fullThoughts.length > MAX_THOUGHT_CHARS) {
            this.logger.warn(`Thought stream exceeded ${MAX_THOUGHT_CHARS} chars — aborting (likely hallucination)`);
            fullThoughts = fullThoughts.slice(0, MAX_THOUGHT_CHARS) + '\n[Thoughts truncated — too long]';
            aborted = true;
            stream.destroy();
            return;
          }

          // Guard: detect repetition — if the last 200 chars repeat verbatim in earlier text
          if (fullThoughts.length > 400) {
            const tail = fullThoughts.slice(-200);
            const earlier = fullThoughts.slice(0, fullThoughts.length - 200);
            if (earlier.includes(tail)) {
              this.logger.warn('Thought stream detected repetition — aborting');
              // Trim to just before the repeated block
              const repeatStart = earlier.indexOf(tail);
              fullThoughts = fullThoughts.slice(0, repeatStart + 200) + '\n[Thoughts truncated — repetition detected]';
              aborted = true;
              stream.destroy();
              return;
            }
          }

          // Publish chunk for real-time UI animation
          this.events.publish('ThoughtChunkGenerated', sessionId, {
            chunk: text,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          }).catch(err => this.logger.warn(`Failed to publish thought chunk: ${err.message}`));
        });

        stream.on('end', () => {
          this.logger.log(`Finished streaming thoughts (${fullThoughts.length} chars)`);
          // Final bulk event for reliability/persistence
          this.events.publish('ThoughtLayerGenerated', sessionId, {
            thoughts: fullThoughts,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
          }).catch(err => this.logger.warn(`Failed to publish full thoughts: ${err.message}`));
          resolve(fullThoughts);
        });

        stream.on('error', (err: any) => {
          this.logger.error(`Thought stream error: ${err.message}`);
          resolve(fullThoughts);
        });

        // Also resolve on destroy (when we abort)
        stream.on('close', () => {
          if (aborted) resolve(fullThoughts);
        });
      });
    } catch (err: any) {
      this.logger.warn(`Streaming thoughts failed: ${err.message}`);
      return '';
    }
  }

  private async generateStreamingResponse(
    sessionId: string,
    interactionId: string,
    clientMessageId: string | undefined,
    payload: any,
    endpoint: string, // '/internal/response/generate-stream' or '/internal/response/chat-stream'
  ): Promise<string> {
    let fullResponse = '';
    const responseUrl = process.env.RESPONSE_URL || 'http://response-generator:8005';
    try {
      this.logger.log(`Starting streaming response (${endpoint}) for session ${sessionId}`);
      const response = await axios({
        method: 'post',
        url: `${responseUrl}${endpoint}`,
        data: payload,
        responseType: 'stream',
        timeout: LLM_TIMEOUT_MS,
      });

      const stream = response.data;
      
      return new Promise((resolve) => {
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          fullResponse += text;
          this.events.publish('ResponseChunkGenerated', sessionId, {
            chunk: text,
            interaction_id: interactionId,
            client_message_id: clientMessageId,
            full_text: fullResponse, // Send current full text for easier UI handling
          }).catch(err => this.logger.warn(`Failed to publish response chunk: ${err.message}`));
        });

        stream.on('end', () => {
          this.logger.log(`Finished streaming response (${fullResponse.length} chars)`);
          resolve(fullResponse);
        });

        stream.on('error', (err: any) => {
          this.logger.error(`Response stream error: ${err.message}`);
          resolve(fullResponse);
        });
      });
    } catch (err: any) {
      this.logger.warn(`Streaming response failed: ${err.message}`);
      return '';
    }
  }

  /** Serialize for Langfuse / debug; truncates to avoid huge observations. */
  private truncateJsonForDebug(value: unknown, maxChars: number): string {
    try {
      const s = JSON.stringify(value);
      if (s.length <= maxChars) {
        return s;
      }
      return `${s.slice(0, maxChars)}…[truncated, total ${s.length} chars]`;
    } catch {
      return '[unserializable]';
    }
  }

  private collapseWhitespacePreview(text: string, maxLen: number): string {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= maxLen) {
      return t;
    }
    return `${t.slice(0, maxLen)}…`;
  }

  private async generateStreamingToolPlan(
    sessionId: string,
    interactionId: string,
    clientMessageId: string | undefined,
    payload: any,
    iteration: number,
    trace?: any,
  ): Promise<any> {
    let fullJsonText = '';
    let lastReasoning = '';
    const responseUrl = process.env.RESPONSE_URL || 'http://response-generator:8005';

    try {
      this.logger.log(`Starting streaming tool-plan for session ${sessionId}, iteration ${iteration}`);
      const response = await axios({
        method: 'post',
        url: `${responseUrl}/internal/response/tool-plan-stream`,
        data: payload,
        responseType: 'stream',
        timeout: LLM_TIMEOUT_MS,
      });

      const stream = response.data;

      return new Promise((resolve) => {
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          fullJsonText += text;

          // Prefer flat `REASONING:` line (tool-plan prompt); fall back to partial JSON "reasoning" string.
          let currentReasoning = '';
          const flatRe = /^\s*REASONING:\s*(.*)$/gim;
          let fm: RegExpExecArray | null;
          while ((fm = flatRe.exec(fullJsonText)) !== null) {
            currentReasoning = (fm[1] ?? '').trimEnd();
          }
          if (!currentReasoning) {
            const reasoningMatch = fullJsonText.match(/"reasoning":\s*"([^"]*)/);
            if (reasoningMatch?.[1]) {
              currentReasoning = reasoningMatch[1];
            }
          }
          if (currentReasoning !== lastReasoning) {
            const delta = currentReasoning.slice(lastReasoning.length);
            if (delta) {
              this.events
                .publish('ToolReasoningChunkGenerated', sessionId, {
                  chunk: delta,
                  full_reasoning: currentReasoning,
                  interaction_id: interactionId,
                  client_message_id: clientMessageId,
                  iteration,
                })
                .catch(err => this.logger.warn(`Failed to publish tool reasoning chunk: ${err.message}`));
              lastReasoning = currentReasoning;
            }
          }
        });

        stream.on('end', async () => {
          this.logger.log(`Finished streaming tool-plan (${fullJsonText.length} chars)`);

          const spanInput: Record<string, unknown> = {
            iteration,
            ...(OASIS_DEBUG_TOOL_PLAN_PAYLOAD
              ? {
                  request_payload_truncated: this.truncateJsonForDebug(payload, OASIS_DEBUG_TOOL_PLAN_MAX_CHARS),
                }
              : {
                  user_message_preview:
                    typeof payload?.user_message === 'string' ? payload.user_message.slice(0, 400) : undefined,
                  tool_results_count: Array.isArray(payload?.tool_results) ? payload.tool_results.length : 0,
                  has_free_thoughts: typeof payload?.free_thoughts === 'string' && payload.free_thoughts.length > 0,
                  has_task_graph: !!payload?.task_graph,
                }),
          };

          const toolPlanObs = trace?.span({
            name: 'tool-plan-stream',
            input: spanInput,
            metadata: {
              iteration,
              interaction_id: interactionId,
              client_message_id: clientMessageId,
              debug_full_payload: OASIS_DEBUG_TOOL_PLAN_PAYLOAD,
            },
          });

          const endToolPlanObs = (output: Record<string, unknown>) => {
            if (!toolPlanObs) {
              return;
            }
            try {
              toolPlanObs.end({ output });
            } catch (lfErr: any) {
              this.logger.warn(`Langfuse tool-plan span end failed: ${lfErr?.message ?? lfErr}`);
            }
          };

          try {
            let result: any;
            let parsePath: string = 'parse-raw';

            try {
              const parseRes = await axios.post(
                `${responseUrl}/internal/response/tool-plan/parse-raw`,
                { raw: fullJsonText },
                { timeout: LLM_TIMEOUT_MS },
              );
              const plan = parseRes.data?.plan;
              if (plan && typeof plan === 'object' && typeof plan.action === 'string') {
                result = plan;
              }
            } catch (parseErr: any) {
              this.logger.warn(
                `tool-plan parse-raw failed (${parseErr?.response?.status ?? 'no-status'}): ${parseErr?.message ?? parseErr}`,
              );
            }

            if (!result) {
              try {
                const repairRes = await axios.post(
                  `${responseUrl}/internal/json/repair`,
                  { malformed_json: fullJsonText },
                  { timeout: LLM_TIMEOUT_MS },
                );
                result = repairRes.data;
                parsePath = 'repair-json';
              } catch {
                const parsed = extractAndParseJson(fullJsonText);
                if (parsed === null || parsed === undefined) {
                  const head = fullJsonText.slice(0, 180).replace(/\s+/g, ' ');
                  const tail = fullJsonText.slice(-180).replace(/\s+/g, ' ');
                  throw new Error(
                    `parse-raw + repair-json failed and JSON could not be extracted (head="${head}", tail="${tail}")`,
                  );
                }
                result = parsed;
                parsePath = 'extract-json-fallback';
              }

              if (!result || typeof result !== 'object') {
                throw new Error(`Parsed tool-plan was not an object (got ${typeof result})`);
              }

              if (typeof (result as any).action !== 'string' && typeof (result as any).answer === 'string') {
                result = { action: 'final_answer', answer: (result as any).answer };
              }
            }

            const out: Record<string, unknown> = {
              raw_len: fullJsonText.length,
              parse_path: parsePath,
              action: (result as any)?.action,
              tool: (result as any)?.tool,
              raw_preview: this.collapseWhitespacePreview(fullJsonText, 1200),
            };
            if (OASIS_DEBUG_TOOL_PLAN_PAYLOAD) {
              out.model_output_truncated = fullJsonText.slice(0, OASIS_DEBUG_TOOL_PLAN_MAX_CHARS);
            }
            endToolPlanObs(out);
            resolve(result);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.error(`Failed to parse final tool-plan: ${msg}`);
            endToolPlanObs({
              error: msg,
              raw_len: fullJsonText.length,
              parse_path: 'fallback-grep',
              raw_preview: this.collapseWhitespacePreview(fullJsonText, 2000),
              ...(OASIS_DEBUG_TOOL_PLAN_PAYLOAD
                ? { model_output_truncated: fullJsonText.slice(0, OASIS_DEBUG_TOOL_PLAN_MAX_CHARS) }
                : {}),
            });
            // Render the raw (non-parsable) tool-plan output in the thoughts UI so it
            // doesn't feel like a silent failure.
            await this.events.publish('ThoughtChunkGenerated', sessionId, {
              chunk:
                `⚠️ Tool-plan output not parsable. Rendering raw output as thought:\n` +
                `${fullJsonText.slice(0, 2500)}` +
                (fullJsonText.length > 2500 ? '\n…(truncated)' : ''),
              interaction_id: interactionId,
              client_message_id: clientMessageId,
              iteration,
            }).catch(err => this.logger.warn(`Failed to publish thought chunk on parse failure: ${err.message}`));
            // Non-fatal: keep the tool loop moving with a deterministic fallback tool call.
            const userMsg = typeof payload?.user_message === 'string' ? payload.user_message : String(payload?.user_message || '');
            const tokenMatch = userMsg.match(/[A-Za-z0-9_]{4,}/);
            const fallbackPattern = tokenMatch ? tokenMatch[0] : 'pattern';
            resolve({
              action: 'call_tool',
              tool: 'grep',
              pattern: fallbackPattern,
              path: '/workspace',
              reasoning: 'Fallback tool-plan: could not parse streamed tool-plan output; using grep to regain grounding.',
            });
          }
        });

        stream.on('error', (err: any) => {
          this.logger.error(`Tool-plan stream error: ${err.message}`);
          try {
            trace
              ?.span({
                name: 'tool-plan-stream',
                metadata: { iteration, interaction_id: interactionId, phase: 'stream_error' },
              })
              ?.end({ output: { error: err.message, raw_len: fullJsonText.length } });
          } catch {
            // ignore Langfuse errors
          }
          resolve({ action: 'final_answer', answer: `Planning interrupted: ${err.message}` });
        });
      });
    } catch (err: any) {
      this.logger.warn(`Streaming tool-plan failed: ${err.message}`);
      try {
        trace
          ?.span({
            name: 'tool-plan-stream',
            metadata: { iteration, interaction_id: interactionId, phase: 'http_request_failed' },
          })
          ?.end({ output: { error: err.message } });
      } catch {
        // ignore Langfuse errors
      }
      return { action: 'final_answer', answer: `Call failed: ${err.message}` };
    }
  }
}
