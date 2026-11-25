import type { InteractionResponsePayload } from '@oasis/ui-kit';
import type { EncryptedPayload, PairingState } from './types';
import { encrypt, decrypt } from './crypto';

/**
 * Callbacks for progressive streaming events from the relay.
 */
export interface StreamCallbacks {
  /** Called with cumulative response text (full_text from ResponseChunkGenerated) */
  onResponseChunk: (fullText: string) => void;
  /** Called with an incremental thinking chunk to append */
  onThinkingChunk: (chunk: string) => void;
  /** Called with a complete thought layer text (replaces accumulated chunks) */
  onThinkingLayer: (fullText: string) => void;
  onThinkingDone: () => void;
  onToolCallStarted: (toolName: string) => void;
  onToolCallCompleted: (toolName: string) => void;
  onFinalResponse: (response: InteractionResponsePayload) => void;
  /** The desktop has the message (first line of the reply). */
  onAccepted?: () => void;
  /** A stream cursor to resume from if the connection drops. */
  onCursor?: (cursor: string) => void;
}

export type StreamOutcome =
  | { status: 'completed' }
  /** Refused or failed on the desktop; sending again won't help. */
  | { status: 'failed'; error: string }
  | { status: 'expired'; error: string }
  | { status: 'aborted' }
  /** Couldn't reach the desktop (or lost the reply) even after resuming: try again later. */
  | { status: 'offline'; error: string; accepted: boolean; cursor: string | null };

export interface StreamOptions {
  /** Stable id for this message: resends with it never start a second turn. */
  clientMessageId: string;
  signal?: AbortSignal;
  projectId?: string;
  /** Resume an interrupted reply after this cursor. */
  resumeAfter?: string | null;
  /** Nothing from the relay (it sends keep-alives every 15 s) for this long: the stream is dead. */
  idleMs?: number;
  /** Resumes tried right away before reporting offline. */
  maxResumes?: number;
  backoffMs?: (attempt: number) => number;
  fetchImpl?: typeof fetch;
}

/** Lines that fail to decrypt in a row before the reply is treated as sealed with another key. */
const MAX_UNDECRYPTABLE = 3;

type AttemptResult =
  | { kind: 'done'; outcome: StreamOutcome }
  | { kind: 'network'; error: string };

/**
 * Send an encrypted chat message through the relay and progressively stream
 * back events (thinking, tool calls, response chunks).
 *
 * When the stream breaks (network drop, tunnel hiccup, a dead connection that
 * stopped sending keep-alives) the same message is sent again with the same
 * client_message_id and the last cursor seen: the desktop doesn't run it twice
 * and the relay replays only what was missed.
 */
export async function streamEncryptedMessage(
  userMessage: string,
  pairing: PairingState,
  callbacks: StreamCallbacks,
  options: StreamOptions,
): Promise<StreamOutcome> {
  if (!pairing.paired || !pairing.sessionKey || !pairing.tunnelUrl || !pairing.pairingId) {
    return { status: 'expired', error: 'Not paired' };
  }
  const maxResumes = options.maxResumes ?? 3;
  const backoff = options.backoffMs || ((n: number) => Math.min(1000 * 2 ** n, 8000));
  const state = { accepted: false, cursor: options.resumeAfter ?? null };
  let lastError = '';

  for (let attempt = 0; attempt <= maxResumes; attempt++) {
    if (options.signal?.aborted) return { status: 'aborted' };
    if (attempt > 0) {
      await wait(backoff(attempt - 1), options.signal);
      if (options.signal?.aborted) return { status: 'aborted' };
    }
    const result = await attemptStream(userMessage, pairing, callbacks, options, state);
    if (result.kind === 'done') return result.outcome;
    lastError = result.error;
  }
  return { status: 'offline', error: lastError, accepted: state.accepted, cursor: state.cursor };
}

async function attemptStream(
  userMessage: string,
  pairing: PairingState,
  callbacks: StreamCallbacks,
  options: StreamOptions,
  state: { accepted: boolean; cursor: string | null },
): Promise<AttemptResult> {
  const doFetch = options.fetchImpl || fetch;
  const idleMs = options.idleMs ?? 45_000;
  const context: Record<string, unknown> = {
    source: 'mobile-companion',
    client_message_id: options.clientMessageId,
    autonomous_mode: false,
    autonomous_max_duration_hours: 0,
  };
  if (options.projectId) context.project_id = options.projectId;

  const body = JSON.stringify({
    user_message: userMessage,
    session_id: pairing.mobileSessionId,
    context,
    ...(state.cursor ? { resume_after: state.cursor } : {}),
  });
  const encrypted = await encrypt(body, pairing.sessionKey!, pairing.pairingId!);

  // One controller per attempt: the caller's signal stops everything, the idle timer only this attempt.
  const attempt = new AbortController();
  const onAbort = () => attempt.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idled = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idled = true; attempt.abort(); }, idleMs);
  };

  try {
    armIdle();
    let res: Response;
    try {
      res = await doFetch(`${pairing.tunnelUrl}/relay/interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(encrypted),
        signal: attempt.signal,
      });
    } catch (err: any) {
      if (options.signal?.aborted) return { kind: 'done', outcome: { status: 'aborted' } };
      return { kind: 'network', error: idled ? 'No answer from the desktop' : (err?.message || 'Network error') };
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: res.statusText }));
      const message = errData.message || errData.error || `Request failed (${res.status})`;
      if (res.status === 401) return { kind: 'done', outcome: { status: 'expired', error: message || 'Session expired' } };
      if (res.status >= 500 || res.status === 408 || res.status === 429) return { kind: 'network', error: message };
      return { kind: 'done', outcome: { status: 'failed', error: message } };
    }

    const reader = res.body?.getReader();
    if (!reader) return { kind: 'network', error: 'No response body' };

    const decoder = new TextDecoder();
    let buffer = '';
    let undecryptable = 0;

    /** Handles one NDJSON line; returns an outcome when the reply is over. */
    const handleLine = async (line: string): Promise<AttemptResult | null> => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let sealed: EncryptedPayload;
      try {
        sealed = JSON.parse(trimmed);
      } catch {
        return null; // a torn line; the resume replays it
      }
      let obj: any;
      try {
        obj = JSON.parse(await decrypt(sealed, pairing.sessionKey!));
        undecryptable = 0;
      } catch {
        undecryptable++;
        if (undecryptable >= MAX_UNDECRYPTABLE) {
          return { kind: 'done', outcome: { status: 'expired', error: "Couldn't read the desktop's reply. Pair again." } };
        }
        return null;
      }

      if (typeof obj._cursor === 'string') {
        state.cursor = obj._cursor;
        callbacks.onCursor?.(obj._cursor);
      }
      if (obj._oasis_keepalive) return null;
      if (obj._oasis_accepted) {
        if (!state.accepted) {
          state.accepted = true;
          callbacks.onAccepted?.();
        }
        return null;
      }
      if (obj._oasis_error) {
        const b = obj.body as { detail?: unknown; error?: string } | undefined;
        let msg = b?.error || 'Interaction failed';
        if (b?.detail != null) msg = typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail);
        if (obj.retryable) return { kind: 'network', error: msg };
        return { kind: 'done', outcome: { status: 'failed', error: msg } };
      }
      if (obj._mobile_event) {
        handleMobileEvent(obj, callbacks);
        return null;
      }
      // The final interaction response.
      if (!state.accepted) {
        state.accepted = true;
        callbacks.onAccepted?.();
      }
      callbacks.onFinalResponse(obj as InteractionResponsePayload);
      return { kind: 'done', outcome: { status: 'completed' } };
    };

    // Not every stack errors the body when its request is aborted: stop waiting on our own.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException('Aborted', 'AbortError'));
      if (attempt.signal.aborted) fail();
      else attempt.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);

    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const out = await handleLine(line);
          if (out) {
            reader.cancel().catch(() => undefined);
            return out;
          }
        }
      }
      // The last line may come without a trailing newline.
      buffer += decoder.decode();
      const out = await handleLine(buffer);
      if (out) return out;
      return { kind: 'network', error: 'The reply was cut off' };
    } catch (err: any) {
      reader.cancel().catch(() => undefined);
      if (options.signal?.aborted) return { kind: 'done', outcome: { status: 'aborted' } };
      return { kind: 'network', error: idled ? 'No answer from the desktop' : (err?.message || 'Connection lost') };
    }
  } finally {
    clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(finish, ms);
    function finish() { clearTimeout(t); signal?.removeEventListener('abort', finish); resolve(); }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Handle a mobile streaming event from the relay's SSE timeline subscription.
 */
function handleMobileEvent(
  event: { event_type: string; payload: Record<string, unknown> },
  callbacks: StreamCallbacks,
): void {
  switch (event.event_type) {
    case 'ResponseChunkGenerated': {
      // payload.full_text is cumulative
      const fullText = (event.payload.full_text as string) || '';
      if (fullText) {
        callbacks.onResponseChunk(fullText);
      }
      break;
    }
    case 'ThoughtChunkGenerated': {
      // payload.chunk is incremental — append
      const chunk = (event.payload.chunk as string) || '';
      if (chunk) {
        callbacks.onThinkingChunk(chunk);
      }
      break;
    }
    case 'ThoughtLayerGenerated': {
      // payload.thoughts is the full text for this thought layer
      const thoughts = (event.payload.thoughts as string) || '';
      if (thoughts) {
        callbacks.onThinkingLayer(thoughts);
      }
      break;
    }
    case 'ToolReasoningChunkGenerated': {
      // payload.full_reasoning is cumulative reasoning for this tool iteration
      const reasoning = (event.payload.full_reasoning as string) || '';
      if (reasoning) {
        callbacks.onThinkingLayer(reasoning);
      }
      break;
    }
    case 'ThoughtsValidated': {
      callbacks.onThinkingDone();
      break;
    }
    case 'ToolCallStarted': {
      const toolName = (event.payload.tool_name as string) || (event.payload.name as string) || 'tool';
      callbacks.onToolCallStarted(toolName);
      break;
    }
    case 'ToolCallCompleted': {
      const toolName = (event.payload.tool_name as string) || (event.payload.name as string) || 'tool';
      callbacks.onToolCallCompleted(toolName);
      break;
    }
  }
}

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}
