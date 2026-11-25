/**
 * Per-edit approval gate (opt-in, per chat, off by default).
 *
 * With the chat's "Review edits" setting on, each edit_file / write_file the agent makes is
 * held before it reaches the dev-agent: the chat is sent the change as a diff
 * (EditApprovalRequested), and the tool call waits until the user approves or rejects it
 * (EditApprovalResolved). The agent's tool result says which, with the user's reason for a
 * rejection. A wait ends on its own after a timeout, and when the turn is stopped, so a turn
 * never hangs on an unanswered card.
 *
 * Why not the waits engine (../waits): a wait ends the turn and resumes it later with a new
 * message. Here the tool call itself has to block and get its answer back in the same turn.
 *
 * The setting, the pending changes and the decisions are kept in Redis (in memory when Redis
 * is out, and in tests), so the card comes back after a reload and a decision posted to
 * another gateway process still reaches the waiting turn (it polls for it).
 */

import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

export const SETTING_KEY_PREFIX = 'oasis:edit-approval:on:';
export const PENDING_KEY_PREFIX = 'oasis:edit-approval:pending:';
export const DECISION_KEY_PREFIX = 'oasis:edit-approval:decision:';

/** How long a change waits for a decision. Under the turn watchdog's 15-minute stall budget. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = Number(process.env.OASIS_EDIT_APPROVAL_TIMEOUT_MS) || 10 * 60_000;
/** How often a waiting call looks for a decision posted to another gateway process. */
export const DECISION_POLL_MS = 2_000;
/** The diff sent to the chat is cut here (a whole generated file can be huge). */
export const MAX_PREVIEW_CHARS = 40_000;
/** A rejection reason is cut here. */
export const MAX_REASON_CHARS = 1_000;

export const GATED_TOOLS = new Set(['edit_file', 'write_file']);

export type EditDecision = 'approved' | 'rejected';
export type GateOutcome = 'approved' | 'rejected' | 'timeout' | 'cancelled';

export interface PendingEdit {
  approval_id: string;
  session_id: string;
  tool: 'edit_file' | 'write_file';
  path: string;
  /** A unified diff of the change (see editPreview). */
  diff: string;
  /** Whether the diff was cut at MAX_PREVIEW_CHARS. */
  truncated: boolean;
  /** Why the agent made the change (its reasoning for the call), when it gave one. */
  reasoning?: string;
  created_at: string;
  expires_at: string;
  interaction_id?: string;
  client_message_id?: string;
}

export interface GateVerdict {
  outcome: GateOutcome;
  reason?: string;
}

// ── Store ───────────────────────────────────────────────────────────────

export interface EditApprovalStore {
  isEnabled(sessionId: string): Promise<boolean>;
  setEnabled(sessionId: string, on: boolean): Promise<void>;
  putPending(p: PendingEdit, ttlMs: number): Promise<void>;
  removePending(sessionId: string, approvalId: string): Promise<void>;
  listPending(sessionId: string): Promise<PendingEdit[]>;
  putDecision(approvalId: string, d: { decision: EditDecision; reason?: string }, ttlMs: number): Promise<void>;
  takeDecision(approvalId: string): Promise<{ decision: EditDecision; reason?: string } | null>;
}

export class MemoryEditApprovalStore implements EditApprovalStore {
  readonly enabled = new Set<string>();
  readonly pending = new Map<string, Map<string, PendingEdit>>();
  readonly decisions = new Map<string, { decision: EditDecision; reason?: string }>();

  async isEnabled(sessionId: string) { return this.enabled.has(sessionId); }
  async setEnabled(sessionId: string, on: boolean) { if (on) this.enabled.add(sessionId); else this.enabled.delete(sessionId); }
  async putPending(p: PendingEdit) {
    const m = this.pending.get(p.session_id) ?? new Map<string, PendingEdit>();
    m.set(p.approval_id, structuredClone(p));
    this.pending.set(p.session_id, m);
  }
  async removePending(sessionId: string, approvalId: string) { this.pending.get(sessionId)?.delete(approvalId); }
  async listPending(sessionId: string) {
    const now = Date.now();
    return [...(this.pending.get(sessionId)?.values() ?? [])].filter((p) => Date.parse(p.expires_at) > now).map((p) => structuredClone(p));
  }
  async putDecision(approvalId: string, d: { decision: EditDecision; reason?: string }) { this.decisions.set(approvalId, { ...d }); }
  async takeDecision(approvalId: string) {
    const d = this.decisions.get(approvalId);
    if (!d) return null;
    this.decisions.delete(approvalId);
    return d;
  }
}

/** The setting is one key per chat; pending changes a hash per chat; decisions one key each. */
export class RedisEditApprovalStore implements EditApprovalStore {
  constructor(private readonly redis: () => Promise<Redis | null>) {}

  async isEnabled(sessionId: string) {
    const r = await this.redis();
    return !!r && (await r.get(SETTING_KEY_PREFIX + sessionId)) === '1';
  }
  async setEnabled(sessionId: string, on: boolean) {
    const r = await this.redis();
    if (!r) throw new Error('Redis is unavailable, so the setting could not be saved');
    if (on) await r.set(SETTING_KEY_PREFIX + sessionId, '1');
    else await r.del(SETTING_KEY_PREFIX + sessionId);
  }
  async putPending(p: PendingEdit, ttlMs: number) {
    const r = await this.redis();
    if (!r) return;
    const key = PENDING_KEY_PREFIX + p.session_id;
    await r.hset(key, p.approval_id, JSON.stringify(p));
    await r.pexpire(key, Math.max(ttlMs, 60_000));
  }
  async removePending(sessionId: string, approvalId: string) {
    const r = await this.redis();
    if (r) await r.hdel(PENDING_KEY_PREFIX + sessionId, approvalId);
  }
  async listPending(sessionId: string) {
    const r = await this.redis();
    if (!r) return [];
    const all = await r.hgetall(PENDING_KEY_PREFIX + sessionId);
    const now = Date.now();
    const out: PendingEdit[] = [];
    for (const v of Object.values(all || {})) {
      try {
        const p = JSON.parse(v) as PendingEdit;
        if (Date.parse(p.expires_at) > now) out.push(p);
      } catch { /* a bad entry is skipped */ }
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async putDecision(approvalId: string, d: { decision: EditDecision; reason?: string }, ttlMs: number) {
    const r = await this.redis();
    if (r) await r.set(DECISION_KEY_PREFIX + approvalId, JSON.stringify(d), 'PX', Math.max(ttlMs, 60_000));
  }
  async takeDecision(approvalId: string) {
    const r = await this.redis();
    if (!r) return null;
    const key = DECISION_KEY_PREFIX + approvalId;
    const v = await r.get(key);
    if (!v) return null;
    await r.del(key);
    try { return JSON.parse(v); } catch { return null; }
  }
}

let redisClient: Redis | null = null;
async function sharedRedis(): Promise<Redis | null> {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
      lazyConnect: true,
    });
    redisClient.on('error', () => undefined);
    try {
      await redisClient.connect();
    } catch {
      redisClient.disconnect();
      redisClient = null;
      return null;
    }
  }
  return redisClient;
}

// ── Diff preview ────────────────────────────────────────────────────────

const lines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

function hunk(oldText: string, newText: string): string {
  const a = lines(oldText);
  const b = lines(newText);
  return [`@@ -1,${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n');
}

function parseEdits(edits: unknown): Array<{ old_string?: string; new_string?: string }> {
  let list = edits;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
}

/**
 * The change as a unified diff, from the call's own arguments (nothing is read from disk).
 * edit_file: one hunk per replacement (old text removed, new text added); line numbers are
 * not known here, so each hunk counts from 1. write_file: the new content as added lines.
 */
export function editPreview(tool: string, args: {
  path?: string; content?: string; old_string?: string; new_string?: string; edits?: unknown; append?: boolean; replace_all?: boolean;
}): { diff: string; truncated: boolean } {
  const file = args.path || '(no path)';
  const header = tool === 'write_file' && !args.append ? [`--- /dev/null`, `+++ b/${file}`] : [`--- a/${file}`, `+++ b/${file}`];
  const hunks: string[] = [];
  if (tool === 'write_file') {
    hunks.push(hunk('', String(args.content ?? '')));
  } else {
    const edits = parseEdits(args.edits);
    if (edits.length) {
      for (const e of edits) hunks.push(hunk(String(e.old_string ?? ''), String(e.new_string ?? '')));
    } else {
      hunks.push(hunk(String(args.old_string ?? ''), String(args.new_string ?? '')));
    }
  }
  let diff = [...header, ...hunks].join('\n');
  let truncated = false;
  if (diff.length > MAX_PREVIEW_CHARS) {
    diff = `${diff.slice(0, MAX_PREVIEW_CHARS)}\n… (cut: the change is longer than ${MAX_PREVIEW_CHARS} characters)`;
    truncated = true;
  }
  return { diff, truncated };
}

/** What the agent's tool call gets back when its change was not made. */
export function verdictOutput(tool: string, path: string, v: GateVerdict, timeoutMs: number): string {
  const what = `${tool} on ${path || 'the file'}`;
  switch (v.outcome) {
    case 'rejected':
      return `Rejected by the user: ${what} was not applied; the file is unchanged.`
        + (v.reason ? ` Their reason: ${v.reason}` : ' They gave no reason.')
        + ' Do not retry the same change: adjust it to what they said, or ask them.';
    case 'timeout':
      return `Not applied: the user did not approve or reject ${what} within ${Math.round(timeoutMs / 60_000) || 1} min; the file is unchanged. `
        + 'Say in your answer which change is waiting for review instead of retrying it.';
    case 'cancelled':
      return `Not applied: the turn was stopped while ${what} waited for the user's approval; the file is unchanged.`;
    default:
      return 'Approved by the user.';
  }
}

// ── Gate ────────────────────────────────────────────────────────────────

export interface GateClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface GateRequest {
  sessionId: string;
  tool: 'edit_file' | 'write_file';
  path: string;
  diff: string;
  truncated?: boolean;
  reasoning?: string;
  interactionId?: string;
  clientMessageId?: string;
}

export interface GateOptions {
  timeoutMs?: number;
  /** The turn's own stop signal. */
  signal?: AbortSignal;
  /** Checked on each poll too (the user's Stop, a closed connection). */
  isAborted?: () => boolean;
  /** The chat is sent the change here (EditApprovalRequested) and the outcome (EditApprovalResolved). */
  publish?: (eventType: string, payload: Record<string, any>) => Promise<void> | void;
}

interface Waiter { sessionId: string; resolve: (v: GateVerdict) => void }

export class EditApprovalGate {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    readonly store: EditApprovalStore,
    private readonly clock: GateClock = realClock,
    private readonly pollMs = DECISION_POLL_MS,
  ) {}

  /** Whether edits in this chat wait for approval. Off (and never throws) when the store is out. */
  async enabledFor(sessionId: string): Promise<boolean> {
    return this.store.isEnabled(sessionId).catch(() => false);
  }

  /** Changes waiting in this chat (the chat shows their cards again after a reload). */
  pending(sessionId: string): Promise<PendingEdit[]> {
    return this.store.listPending(sessionId).catch(() => []);
  }

  /**
   * Holds a change until it is approved, rejected, the wait times out, or the turn is stopped.
   * Never throws: a failure to save the pending change still waits on the in-process decision.
   */
  async request(r: GateRequest, opts: GateOptions = {}): Promise<GateVerdict & { approval_id: string }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const approvalId = uuidv4();
    const created = this.clock.now();
    const pending: PendingEdit = {
      approval_id: approvalId,
      session_id: r.sessionId,
      tool: r.tool,
      path: r.path,
      diff: r.diff,
      truncated: !!r.truncated,
      ...(r.reasoning ? { reasoning: r.reasoning.slice(0, 2_000) } : {}),
      created_at: new Date(created).toISOString(),
      expires_at: new Date(created + timeoutMs).toISOString(),
      ...(r.interactionId ? { interaction_id: r.interactionId } : {}),
      ...(r.clientMessageId ? { client_message_id: r.clientMessageId } : {}),
    };

    const verdict = await new Promise<GateVerdict>((resolve) => {
      let done = false;
      let timer: unknown;
      let poller: unknown;
      const finish = (v: GateVerdict) => {
        if (done) return;
        done = true;
        this.clock.clearTimeout(timer);
        this.clock.clearTimeout(poller);
        this.waiters.delete(approvalId);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => finish({ outcome: 'cancelled' });
      if (opts.signal?.aborted || opts.isAborted?.()) { finish({ outcome: 'cancelled' }); return; }
      opts.signal?.addEventListener('abort', onAbort);
      this.waiters.set(approvalId, { sessionId: r.sessionId, resolve: finish });
      timer = this.clock.setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
      // A decision posted to another gateway process, and a Stop the signal did not carry.
      const poll = async () => {
        if (done) return;
        if (opts.isAborted?.()) { finish({ outcome: 'cancelled' }); return; }
        const d = await this.store.takeDecision(approvalId).catch(() => null);
        if (d) { finish({ outcome: d.decision, ...(d.reason ? { reason: d.reason } : {}) }); return; }
        if (!done) poller = this.clock.setTimeout(() => void poll(), this.pollMs);
      };
      poller = this.clock.setTimeout(() => void poll(), this.pollMs);
      // Saved and announced after the waiter is registered, so an instant decision is never missed.
      void (async () => {
        await this.store.putPending(pending, timeoutMs).catch(() => undefined);
        if (!done) await Promise.resolve(opts.publish?.('EditApprovalRequested', { ...pending })).catch(() => undefined);
      })();
    });

    await this.store.removePending(r.sessionId, approvalId).catch(() => undefined);
    await Promise.resolve(opts.publish?.('EditApprovalResolved', {
      approval_id: approvalId, tool: r.tool, path: r.path, outcome: verdict.outcome,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(r.interactionId ? { interaction_id: r.interactionId } : {}),
      ...(r.clientMessageId ? { client_message_id: r.clientMessageId } : {}),
    })).catch(() => undefined);
    return { ...verdict, approval_id: approvalId };
  }

  /**
   * The user's answer. Resolves a call waiting in this process at once; otherwise the decision
   * is saved for the process that holds the call (it polls). False for a change that is not
   * pending in this chat (answered already, timed out, or someone else's).
   */
  async decide(sessionId: string, approvalId: string, decision: EditDecision, reason?: string): Promise<boolean> {
    const why = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) : '';
    const local = this.waiters.get(approvalId);
    if (local) {
      if (local.sessionId !== sessionId) return false;
      local.resolve({ outcome: decision, ...(why ? { reason: why } : {}) });
      return true;
    }
    const pending = await this.store.listPending(sessionId).catch(() => [] as PendingEdit[]);
    const held = pending.find((p) => p.approval_id === approvalId);
    if (!held) return false;
    await this.store.putDecision(approvalId, { decision, ...(why ? { reason: why } : {}) }, Math.max(Date.parse(held.expires_at) - this.clock.now(), 0) + 60_000);
    return true;
  }

  /** Calls waiting in this process (tests, diagnostics). */
  get waiting(): number {
    return this.waiters.size;
  }
}

let defaultGate: EditApprovalGate | null = null;

/** The gateway's gate, shared by the tool loop and the controller. */
export function editApprovalGate(): EditApprovalGate {
  defaultGate ??= new EditApprovalGate(new RedisEditApprovalStore(sharedRedis));
  return defaultGate;
}
