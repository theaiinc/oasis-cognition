import { describe, expect, it, vi } from 'vitest';
import { encrypt, decrypt, deriveSessionKey } from '../src/lib/crypto';
import { streamEncryptedMessage, type StreamCallbacks } from '../src/lib/interaction-api';
import type { PairingState } from '../src/lib/types';

async function makeKey(seed: number) {
  const a = new Uint8Array(32).fill(seed), b = new Uint8Array(32).fill(seed + 1);
  return deriveSessionKey(a.buffer, b.buffer);
}

async function setup() {
  const key = await makeKey(1);
  const pairing: PairingState = {
    paired: true, tunnelUrl: 'https://tunnel.test', sessionKey: key, pairingId: 'pid', mobileSessionId: 'mobile-1', expiresAt: new Date(Date.now() + 3600_000),
  };
  const line = async (obj: unknown, k: CryptoKey = key) => JSON.stringify(await encrypt(JSON.stringify(obj), k, 'pid')) + '\n';
  return { key, pairing, line };
}

/** A fetch Response whose body yields these chunks, then ends (or errors, or hangs). */
function response(chunks: Array<string | Uint8Array>, end: 'close' | 'error' | 'hang' = 'close', status = 200): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        const c = chunks[i++];
        controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
        return;
      }
      if (end === 'close') controller.close();
      else if (end === 'error') controller.error(new TypeError('network error'));
      else return new Promise(() => undefined);
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'application/x-ndjson' } });
}

function callbacks() {
  const log: string[] = [];
  const cb: StreamCallbacks = {
    onResponseChunk: (t) => log.push(`text:${t}`),
    onThinkingChunk: (t) => log.push(`think:${t}`),
    onThinkingLayer: (t) => log.push(`layer:${t}`),
    onThinkingDone: () => log.push('thought'),
    onToolCallStarted: (n) => log.push(`tool:${n}`),
    onToolCallCompleted: (n) => log.push(`tool-done:${n}`),
    onFinalResponse: (r) => log.push(`final:${r.response}`),
    onAccepted: () => log.push('accepted'),
  };
  return { cb, log };
}

const event = (event_type: string, payload: Record<string, unknown>, cursor: string) => ({ _mobile_event: true, event_type, payload, _cursor: cursor });

/** What the phone sent in each request, decrypted. */
async function sentBodies(fetchMock: ReturnType<typeof vi.fn>, key: CryptoKey) {
  return Promise.all(fetchMock.mock.calls.map(async ([, init]) => JSON.parse(await decrypt(JSON.parse(init.body), key))));
}

describe('streamEncryptedMessage', () => {
  it('streams events and the final reply, even split mid-line and mid-character', async () => {
    const { key, pairing, line } = await setup();
    const full = (await line({ _oasis_accepted: true, _cursor: '1-0' }))
      + (await line(event('ThoughtChunkGenerated', { chunk: 'hmm' }, '2-0')))
      + (await line({ _oasis_keepalive: true }))
      + (await line(event('ResponseChunkGenerated', { full_text: 'Xin chào' }, '3-0')))
      + (await line({ response: 'Xin chào', _cursor: '4-0' })).trimEnd(); // last line without newline
    const bytes = new TextEncoder().encode(full);
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 150), bytes.slice(150, 151), bytes.slice(151)];
    const fetchMock = vi.fn(async () => response(chunks));
    const { cb, log } = callbacks();
    const cursors: string[] = [];
    const outcome = await streamEncryptedMessage('hi', pairing, { ...cb, onCursor: (c) => cursors.push(c) }, { clientMessageId: 'm1', fetchImpl: fetchMock as any });
    expect(outcome).toEqual({ status: 'completed' });
    expect(log).toEqual(['accepted', 'think:hmm', 'text:Xin chào', 'final:Xin chào']);
    expect(cursors).toEqual(['1-0', '2-0', '3-0', '4-0']);
    const [body] = await sentBodies(fetchMock, key);
    expect(body).toMatchObject({ user_message: 'hi', session_id: 'mobile-1', context: { client_message_id: 'm1' } });
    expect(body).not.toHaveProperty('resume_after');
  });

  it('reports an error on the last line instead of an empty reply', async () => {
    const { pairing, line } = await setup();
    const last = (await line({ _oasis_error: true, retryable: false, body: { error: 'Budget reached' } })).trimEnd();
    const { cb } = callbacks();
    const outcome = await streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: (async () => response([last])) as any });
    expect(outcome).toEqual({ status: 'failed', error: 'Budget reached' });
  });

  it('resumes a dropped stream with the same id from the last cursor, without repeating events', async () => {
    const { key, pairing, line } = await setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([
        await line({ _oasis_accepted: true, _cursor: '1-0' }),
        await line(event('ThoughtChunkGenerated', { chunk: 'a' }, '2-0')),
        '{"iv":"torn', // half a line, then the connection dies
      ], 'error'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response([
        await line({ _oasis_accepted: true, duplicate: true, _cursor: '2-0' }),
        await line(event('ThoughtChunkGenerated', { chunk: 'b' }, '3-0')),
        await line({ response: 'done', _cursor: '4-0' }),
      ]));
    const { cb, log } = callbacks();
    const outcome = await streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: fetchMock, backoffMs: () => 1 });
    expect(outcome).toEqual({ status: 'completed' });
    expect(log).toEqual(['accepted', 'think:a', 'think:b', 'final:done']);
    const bodies = await sentBodies(fetchMock, key);
    expect(bodies.map(b => [b.context.client_message_id, b.resume_after])).toEqual([['m1', undefined], ['m1', '2-0'], ['m1', '2-0']]);
  });

  it('treats a stream that goes silent as dropped and resumes it', async () => {
    const { pairing, line } = await setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([await line({ _oasis_accepted: true, _cursor: '1-0' })], 'hang'))
      .mockResolvedValueOnce(response([await line({ response: 'late', _cursor: '9-0' })]));
    const { cb, log } = callbacks();
    const outcome = await streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: fetchMock, idleMs: 30, backoffMs: () => 1 });
    expect(outcome).toEqual({ status: 'completed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['accepted', 'final:late']);
  });

  it('resumes after a retryable relay error, not after a final one', async () => {
    const { pairing, line } = await setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([await line({ _oasis_error: true, retryable: true, body: { error: 'Desktop is unreachable' } })]))
      .mockResolvedValueOnce(response([await line({ response: 'ok' })]));
    const { cb } = callbacks();
    await expect(streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: fetchMock, backoffMs: () => 1 })).resolves.toEqual({ status: 'completed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports offline after the resumes run out, with what it knows for later', async () => {
    const { pairing, line } = await setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([await line({ _oasis_accepted: true, _cursor: '5-0' })], 'error'))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const { cb } = callbacks();
    const outcome = await streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: fetchMock, maxResumes: 2, backoffMs: () => 1 });
    expect(outcome).toEqual({ status: 'offline', error: 'Failed to fetch', accepted: true, cursor: '5-0' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an expired session or a refused message', async () => {
    const { pairing } = await setup();
    const { cb } = callbacks();
    const expired = vi.fn(async () => new Response(JSON.stringify({ message: 'No active session' }), { status: 401 }));
    await expect(streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: expired as any })).resolves.toMatchObject({ status: 'expired' });
    expect(expired).toHaveBeenCalledTimes(1);
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid encrypted payload' }), { status: 400 }));
    await expect(streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: refused as any })).resolves.toEqual({ status: 'failed', error: 'Invalid encrypted payload' });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('skips a line it cannot decrypt, but gives up on a reply sealed with another key', async () => {
    const { pairing, line } = await setup();
    const other = await makeKey(9);
    const { cb, log } = callbacks();
    const oneBad = vi.fn(async () => response([await line({ _oasis_keepalive: true }, other), await line({ response: 'fine' })]));
    await expect(streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: oneBad as any })).resolves.toEqual({ status: 'completed' });
    expect(log).toContain('final:fine');
    const allBad = vi.fn(async () => response([await line({ a: 1 }, other), await line({ a: 2 }, other), await line({ response: 'x' }, other)]));
    await expect(streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: allBad as any })).resolves.toMatchObject({ status: 'expired' });
    expect(allBad).toHaveBeenCalledTimes(1);
  });

  it('stops quietly when the user cancels', async () => {
    const { pairing, line } = await setup();
    const stop = new AbortController();
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      const res = response([await line({ _oasis_accepted: true })], 'hang');
      setTimeout(() => stop.abort(), 10);
      init.signal?.addEventListener('abort', () => undefined);
      return res;
    });
    const { cb } = callbacks();
    // The hanging body never ends on its own; abort ends the read.
    const outcome = await streamEncryptedMessage('hi', pairing, cb, { clientMessageId: 'm1', fetchImpl: fetchMock as any, signal: stop.signal, idleMs: 5000 });
    expect(outcome).toEqual({ status: 'aborted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
