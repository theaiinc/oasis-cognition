import { SseParser } from '../src/relay/sse';
import { followTurn, OpenStream, StreamHttpError } from '../src/relay/timeline-follower';

const sse = (id: string | null, event: Record<string, unknown>) =>
  `${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
const ev = (event_type: string, payload: Record<string, unknown> = {}) => ({ event_type, session_id: 's1', payload });

/** An async iterable of chunks that can stay open (hang) after the last one. */
function stream(chunks: string[], opts: { hang?: boolean; fail?: Error } = {}): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
      if (opts.fail) throw opts.fail;
      if (opts.hang) await new Promise(() => undefined);
    },
  };
}

function fakeOpen(connections: Array<() => AsyncIterable<string> | Promise<never>>) {
  const urls: string[] = [];
  const open: OpenStream = async (url) => {
    urls.push(url);
    const next = connections.shift();
    if (!next) return stream([], { hang: true });
    return next() as any;
  };
  return { open, urls };
}

const base = { sessionId: 's1', clientMessageId: 'm1', gatewayUrl: 'http://gw', backoffMs: () => 1 };

describe('SseParser', () => {
  it('reassembles events split across chunks, CRLF and multi-line data', () => {
    const p = new SseParser();
    expect(p.push('id: 1-0\r\nda')).toEqual([]);
    expect(p.push('ta: {"a":\r\ndata: 1}\r\n')).toEqual([]);
    expect(p.push('\r')).toEqual([]);
    expect(p.push('\n: comment\n\nevent: ping\ndata: x\n\n')).toEqual([
      { id: '1-0', event: undefined, data: '{"a":\n1}' },
      { id: undefined, event: 'ping', data: 'x' },
    ]);
  });
});

describe('followTurn', () => {
  it('starts from the accept cursor, forwards this turn only, and ends on its completion', async () => {
    const { open, urls } = fakeOpen([() => stream([
      sse('5-0', ev('ResponseChunkGenerated', { client_message_id: 'other', full_text: 'not mine' })),
      sse('6-0', ev('ThoughtChunkGenerated', { client_message_id: 'm1', chunk: 'hm' })),
      sse(null, ev('TimelineKeepAlive')),
      sse('7-0', ev('ResponseChunkGenerated', { client_message_id: 'm1', full_text: 'Hi' })),
      sse('8-0', ev('InteractionCompleted', { client_message_id: 'other', response: 'no' })),
      sse('9-0', ev('InteractionCompleted', { client_message_id: 'm1', response: 'Hi there' })),
    ], { hang: true })]);
    const seen: Array<[string, string | null]> = [];
    const result = await followTurn({ ...base, after: '4-0', open, signal: new AbortController().signal, onEvent: (e, c) => seen.push([e.event_type, c]) });
    expect(result).toEqual({ outcome: 'completed', response: 'Hi there', cursor: '9-0' });
    expect(seen).toEqual([['ThoughtChunkGenerated', '6-0'], ['ResponseChunkGenerated', '7-0']]);
    expect(urls).toEqual(['http://gw/api/v1/events/timeline?session_id=s1&after=4-0']);
  });

  it('reconnects from the last event id after the stream drops, without repeating events', async () => {
    const { open, urls } = fakeOpen([
      () => stream([sse('10-0', ev('ResponseChunkGenerated', { client_message_id: 'm1', full_text: 'a' }))], { fail: new Error('socket hang up') }),
      () => Promise.reject(new Error('ECONNREFUSED')) as never,
      () => stream([sse('11-0', ev('PipelineFailed', { client_message_id: 'm1', error: 'Interaction failed' }))]),
    ]);
    const seen: string[] = [];
    const result = await followTurn({ ...base, after: '9-0', open, signal: new AbortController().signal, onEvent: (_e, c) => seen.push(String(c)) });
    expect(result).toEqual({ outcome: 'failed', error: 'Interaction failed', cursor: '11-0' });
    expect(seen).toEqual(['10-0']);
    expect(urls.map(u => new URL(u).searchParams.get('after'))).toEqual(['9-0', '10-0', '10-0']);
  });

  it('treats a silent stream as dead and reconnects', async () => {
    const { open, urls } = fakeOpen([
      () => stream([], { hang: true }),
      () => stream([sse('3-0', ev('PipelineCancelled', { client_message_id: 'm1', reason: 'Replaced by a newer message' }))]),
    ]);
    const result = await followTurn({ ...base, after: '2-0', idleMs: 20, open, signal: new AbortController().signal, onEvent: () => undefined });
    expect(result).toEqual({ outcome: 'cancelled', error: 'Replaced by a newer message', cursor: '3-0' });
    expect(urls).toHaveLength(2);
  });

  it('gives up after repeated dead connections, keeping the cursor for a resume', async () => {
    const fail = () => Promise.reject(new Error('ECONNREFUSED')) as never;
    const { open, urls } = fakeOpen([fail, fail, fail, fail]);
    const result = await followTurn({ ...base, after: '2-0', maxReconnects: 2, open, signal: new AbortController().signal, onEvent: () => undefined });
    expect(result).toEqual({ outcome: 'unreachable', error: 'ECONNREFUSED', cursor: '2-0' });
    expect(urls).toHaveLength(3);
  });

  it('stops on a 4xx from the timeline (bad cursor, no access)', async () => {
    const { open } = fakeOpen([() => Promise.reject(new StreamHttpError(400)) as never]);
    const result = await followTurn({ ...base, after: '2-0', open, signal: new AbortController().signal, onEvent: () => undefined });
    expect(result).toMatchObject({ outcome: 'failed' });
  });

  it('ends when the caller aborts, and times out a turn that never ends', async () => {
    const stop = new AbortController();
    const { open } = fakeOpen([() => stream([], { hang: true })]);
    const pending = followTurn({ ...base, after: null, open, signal: stop.signal, onEvent: () => undefined });
    setTimeout(() => stop.abort(), 10);
    await expect(pending).resolves.toEqual({ outcome: 'aborted', cursor: null });

    const live = fakeOpen([() => stream([sse(null, ev('TimelineKeepAlive'))], { hang: true })]);
    const result = await followTurn({ ...base, after: null, maxTurnMs: 30, open: live.open, signal: new AbortController().signal, onEvent: () => undefined });
    expect(result.outcome).toBe('timeout');
    expect(new URL(live.urls[0]).searchParams.get('backlog')).toBe('0');
  });
});
