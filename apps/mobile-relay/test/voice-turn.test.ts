import axios from 'axios';
import { runVoiceTurn } from '../src/relay/voice-bridge';
import type { FollowOptions, FollowResult } from '../src/relay/timeline-follower';

afterEach(() => jest.restoreAllMocks());

const accepted = { data: { session_id: 's1', client_message_id: 'v1', event_cursor: '41-0' } };

function run(follow: (o: FollowOptions) => Promise<FollowResult>, signal = new AbortController().signal) {
  const sent: any[] = [];
  return runVoiceTurn({ transcript: 'what time is it', sessionId: 's1', clientMessageId: 'v1', send: (m) => sent.push(m), signal, follow })
    .then(() => sent);
}

describe('runVoiceTurn', () => {
  it('sends user_message, follows from the accept cursor and ends with the reply', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue(accepted);
    let followed: FollowOptions | null = null;
    const sent = await run(async (o) => {
      followed = o;
      o.onEvent({ event_type: 'ThoughtChunkGenerated', payload: { client_message_id: 'v1', chunk: 'hm' } }, '42-0');
      o.onEvent({ event_type: 'ResponseChunkGenerated', payload: { client_message_id: 'v1', full_text: 'It is' } }, '43-0');
      o.onEvent({ event_type: 'ResponseChunkGenerated', payload: { client_message_id: 'v1', full_text: 'It is noon' } }, '44-0');
      return { outcome: 'completed', response: 'It is noon.', cursor: '45-0' };
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({
      user_message: 'what time is it',
      session_id: 's1',
      context: { source: 'mobile-voice', client_message_id: 'v1' },
    });
    expect(followed!.after).toBe('41-0');
    expect(followed!.clientMessageId).toBe('v1');
    expect(sent.filter((m) => m.type === 'response-chunk').map((m) => m.text)).toEqual(['It is', 'It is noon']);
    expect(sent.filter((m) => m.type === 'stream-event').map((m) => m.event_type))
      .toEqual(['ThoughtChunkGenerated', 'ResponseChunkGenerated', 'ResponseChunkGenerated']);
    expect(sent[sent.length - 1]).toEqual({ type: 'response', text: 'It is noon.', confidence: 1, client_message_id: 'v1' });
  });

  it('falls back to the streamed text when the final event has none', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue(accepted);
    const sent = await run(async (o) => {
      o.onEvent({ event_type: 'ResponseChunkGenerated', payload: { full_text: 'Partial' } }, '42-0');
      return { outcome: 'completed', response: '', cursor: '43-0' };
    });
    expect(sent[sent.length - 1]).toMatchObject({ type: 'response', text: 'Partial' });
  });

  it('reports a refused message without following', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue({ response: { status: 400, data: { message: 'user_message must be nonempty text' } } });
    const follow = jest.fn();
    const sent = await run(follow as any);
    expect(follow).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'error', message: 'user_message must be nonempty text', client_message_id: 'v1' }]);
  });

  it('reports a failed or lost turn as an error', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue(accepted);
    for (const outcome of ['failed', 'cancelled', 'unreachable', 'timeout'] as const) {
      const sent = await run(async () => ({ outcome, error: `turn ${outcome}`, cursor: null }));
      expect(sent).toEqual([{ type: 'error', message: `turn ${outcome}`, client_message_id: 'v1' }]);
    }
  });

  it('sends nothing more once the socket has closed', async () => {
    const ctl = new AbortController();
    ctl.abort();
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('canceled'));
    const sent = await run(jest.fn() as any, ctl.signal);
    expect(sent).toEqual([]);
  });
});
