import http from 'http';
import https from 'https';
import { SseParser } from './sse';
import { GATEWAY_URL } from '../gateway';

/** Timeline events worth forwarding to the phone while a turn runs. */
export const FORWARD_EVENT_TYPES = new Set([
  'ResponseChunkGenerated',
  'ToolCallStarted',
  'ToolCallCompleted',
  'ToolReasoningChunkGenerated',
  'ThoughtChunkGenerated',
  'ThoughtLayerGenerated',
  'ThoughtsValidated',
]);

/** Events the gateway's interaction controller publishes when a turn ends. */
const TERMINAL = new Set(['InteractionCompleted', 'PipelineFailed', 'PipelineCancelled']);

export interface TimelineEvent {
  event_type: string;
  session_id?: string;
  payload: Record<string, any>;
}

export type FollowResult =
  | { outcome: 'completed'; response: string; cursor: string | null }
  | { outcome: 'failed' | 'cancelled'; error: string; cursor: string | null }
  /** The gateway stayed unreachable, or the turn ran past maxTurnMs: the phone may resume later. */
  | { outcome: 'unreachable' | 'timeout'; error: string; cursor: string | null }
  | { outcome: 'aborted'; cursor: string | null };

/** Opens the timeline stream; resolves once the response headers say 200. */
export type OpenStream = (url: string, signal: AbortSignal) => Promise<AsyncIterable<Buffer | string>>;

export interface FollowOptions {
  sessionId: string;
  clientMessageId: string;
  /** Redis stream id to replay from (exclusive); null for live events only. */
  after: string | null;
  onEvent: (event: TimelineEvent, cursor: string | null) => void;
  signal: AbortSignal;
  open?: OpenStream;
  gatewayUrl?: string;
  /** No bytes (the gateway pings every 20 s) for this long: the stream is dead, reconnect. */
  idleMs?: number;
  /** Give up on a turn after this long, whatever happens. */
  maxTurnMs?: number;
  /** Consecutive reconnects that bring nothing before giving up. */
  maxReconnects?: number;
  backoffMs?: (attempt: number) => number;
}

export class StreamHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Timeline stream refused (${status})`);
  }
}

export const defaultOpen: OpenStream = (url, signal) => new Promise((resolve, reject) => {
  const get = url.startsWith('https:') ? https.get : http.get;
  const req = get(url, { headers: { Accept: 'text/event-stream' }, signal }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      reject(new StreamHttpError(res.statusCode || 0));
      return;
    }
    resolve(res);
  });
  req.on('error', reject);
});

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/**
 * Follow one turn on the gateway's timeline until it ends.
 *
 * Starts from `after` (the cursor the gateway returned when it accepted the
 * message, or the last cursor a resuming phone saw) so nothing between accept
 * and subscribe is missed. When the stream drops or goes quiet past `idleMs`,
 * it reconnects from the last event id it saw, so events are neither lost nor
 * repeated. Events of other turns in the same chat are skipped.
 */
export async function followTurn(opts: FollowOptions): Promise<FollowResult> {
  const open = opts.open || defaultOpen;
  const idleMs = opts.idleMs ?? 45_000;
  const maxTurnMs = opts.maxTurnMs ?? 30 * 60_000;
  const maxReconnects = opts.maxReconnects ?? 8;
  const backoff = opts.backoffMs || ((n: number) => Math.min(500 * 2 ** n, 8_000));
  const base = (opts.gatewayUrl || GATEWAY_URL).replace(/\/+$/, '');
  const deadline = Date.now() + maxTurnMs;

  let cursor = opts.after;
  let failures = 0;
  let lastError = '';

  while (!opts.signal.aborted) {
    if (Date.now() >= deadline) return { outcome: 'timeout', error: 'The turn took too long', cursor };
    const url = new URL(`${base}/api/v1/events/timeline`);
    url.searchParams.set('session_id', opts.sessionId);
    if (cursor) url.searchParams.set('after', cursor);
    else url.searchParams.set('backlog', '0');

    const conn = new AbortController();
    const abortConn = () => conn.abort();
    opts.signal.addEventListener('abort', abortConn, { once: true });
    let progressed = false;
    let gotBytes = false;
    try {
      const stream = await open(url.toString(), conn.signal);
      const iterator = stream[Symbol.asyncIterator]();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      // Don't rely on the stream erroring when the connection is aborted: stop waiting at once.
      const aborted = new Promise<'aborted'>((r) => {
        if (conn.signal.aborted) r('aborted');
        conn.signal.addEventListener('abort', () => r('aborted'), { once: true });
      });
      while (true) {
        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) return { outcome: 'timeout', error: 'The turn took too long', cursor };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<'idle'>((r) => { timer = setTimeout(() => r('idle'), Math.min(idleMs, timeLeft)); });
        const next = await Promise.race([iterator.next(), idle, aborted]).finally(() => clearTimeout(timer));
        if (next === 'aborted') {
          iterator.return?.().catch(() => undefined);
          break;
        }
        if (next === 'idle') {
          lastError = 'Timeline stream went quiet';
          conn.abort();
          iterator.return?.().catch(() => undefined);
          break;
        }
        if (next.done) { lastError = 'Timeline stream ended'; break; }
        gotBytes = true;
        const text = typeof next.value === 'string' ? next.value : decoder.decode(next.value, { stream: true });
        for (const msg of parser.push(text)) {
          let event: TimelineEvent;
          try { event = JSON.parse(msg.data); } catch { continue; }
          if (msg.id) { cursor = msg.id; progressed = true; }
          if (!event || typeof event.event_type !== 'string') continue;
          const payload = event.payload || {};
          const cmid = payload.client_message_id;
          if (cmid && cmid !== opts.clientMessageId) continue;
          if (TERMINAL.has(event.event_type) && cmid === opts.clientMessageId) {
            if (event.event_type === 'InteractionCompleted') {
              return { outcome: 'completed', response: typeof payload.response === 'string' ? payload.response : '', cursor };
            }
            const error = String(payload.reason || payload.error || (event.event_type === 'PipelineCancelled' ? 'Stopped' : 'Interaction failed'));
            return { outcome: event.event_type === 'PipelineCancelled' ? 'cancelled' : 'failed', error, cursor };
          }
          if (FORWARD_EVENT_TYPES.has(event.event_type)) opts.onEvent({ ...event, payload }, cursor);
        }
      }
    } catch (err: any) {
      if (opts.signal.aborted) break;
      if (err instanceof StreamHttpError && err.status >= 400 && err.status < 500) {
        return { outcome: 'failed', error: err.message, cursor };
      }
      lastError = err?.message || String(err);
    } finally {
      opts.signal.removeEventListener('abort', abortConn);
      conn.abort();
    }
    if (opts.signal.aborted) break;
    // A connection that delivered anything (even keep-alives) was healthy, so the
    // count of failed tries starts over; only back-to-back dead connections add up.
    failures = gotBytes ? 0 : failures + 1;
    if (failures > maxReconnects) return { outcome: 'unreachable', error: lastError || 'Timeline unreachable', cursor };
    await sleep(progressed ? 0 : backoff(Math.max(0, failures - 1)), opts.signal);
  }
  return { outcome: 'aborted', cursor };
}
