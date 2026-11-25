import axios from 'axios';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { SessionService } from '../src/session/session.service';
import { RelayService } from '../src/relay/relay.service';
import { createRelayRouter } from '../src/relay/relay.controller';
import { encrypt, decrypt, generateHalfKey } from '../src/crypto/crypto.service';
import type { FollowOptions, FollowResult } from '../src/relay/timeline-follower';

function paired() {
  const sessions = new SessionService();
  const { pairingId } = sessions.initiatePairing('https://tunnel.example', 1);
  sessions.completePairing(pairingId, generateHalfKey().encoded);
  const key = sessions.getSessionKeyForPairing(pairingId)!;
  return { sessions, pairingId, key, mobileSessionId: sessions.getActiveSession()!.mobileSessionId };
}

afterEach(() => jest.restoreAllMocks());

describe('RelayService.streamInteraction', () => {
  it('sends once, replays from the accept cursor and ends with the response', async () => {
    const { sessions, pairingId, key, mobileSessionId } = paired();
    const relay = new RelayService(sessions);
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { session_id: mobileSessionId, client_message_id: 'm1', event_cursor: '41-0' } });
    let followed: FollowOptions | null = null;
    const follow = async (o: FollowOptions): Promise<FollowResult> => {
      followed = o;
      o.onEvent({ event_type: 'ResponseChunkGenerated', payload: { client_message_id: 'm1', full_text: 'Hel' } }, '42-0');
      return { outcome: 'completed', response: 'Hello', cursor: '43-0' };
    };
    const lines: any[] = [];
    const done = jest.fn();
    await relay.streamInteraction(
      { user_message: 'hi', session_id: 'ignored', context: { client_message_id: 'm1' } },
      pairingId, mobileSessionId, (p) => lines.push(JSON.parse(decrypt(p, key))), done, new AbortController().signal, follow,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({ session_id: mobileSessionId, context: { client_message_id: 'm1', source: 'mobile-companion' } });
    expect(followed!.after).toBe('41-0');
    expect(lines).toEqual([
      { _oasis_accepted: true, client_message_id: 'm1', duplicate: false, _cursor: '41-0' },
      { _mobile_event: true, event_type: 'ResponseChunkGenerated', payload: { client_message_id: 'm1', full_text: 'Hel' }, _cursor: '42-0' },
      { session_id: mobileSessionId, client_message_id: 'm1', response: 'Hello', _cursor: '43-0' },
    ]);
    expect(done).toHaveBeenCalledTimes(1);
    sessions.destroy();
  });

  it('resumes a resent message from the cursor the phone last saw', async () => {
    const { sessions, pairingId, key, mobileSessionId } = paired();
    const relay = new RelayService(sessions);
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { client_message_id: 'm1', event_cursor: '41-0', duplicate: true } });
    let after: string | null = null;
    const lines: any[] = [];
    await relay.streamInteraction(
      { user_message: 'hi', resume_after: '42-0', context: { client_message_id: 'm1' } },
      pairingId, mobileSessionId, (p) => lines.push(JSON.parse(decrypt(p, key))), () => undefined, new AbortController().signal,
      async (o) => { after = o.after; return { outcome: 'completed', response: 'ok', cursor: '50-0' }; },
    );
    expect(after).toBe('42-0');
    expect(post.mock.calls[0][1]).not.toHaveProperty('resume_after');
    expect(lines[0]).toMatchObject({ _oasis_accepted: true, duplicate: true });
    sessions.destroy();
  });

  it('reports an unreachable gateway as retryable and a 4xx as final', async () => {
    const { sessions, pairingId, key, mobileSessionId } = paired();
    const relay = new RelayService(sessions);
    const follow = jest.fn();
    const run = async () => {
      const lines: any[] = [];
      await relay.streamInteraction({ user_message: 'hi', context: { client_message_id: 'm1' } }, pairingId, mobileSessionId,
        (p) => lines.push(JSON.parse(decrypt(p, key))), () => undefined, new AbortController().signal, follow);
      return lines;
    };
    jest.spyOn(axios, 'post').mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(await run()).toEqual([{ _oasis_error: true, retryable: true, body: { error: 'Desktop is unreachable' } }]);
    jest.spyOn(axios, 'post').mockRejectedValueOnce({ response: { status: 400, data: { message: 'user_message must be nonempty text' } } });
    expect(await run()).toEqual([{ _oasis_error: true, retryable: false, body: { error: 'user_message must be nonempty text' } }]);
    expect(follow).not.toHaveBeenCalled();
    sessions.destroy();
  });

  it('marks a turn it lost track of as retryable, with the cursor to resume from', async () => {
    const { sessions, pairingId, key, mobileSessionId } = paired();
    const relay = new RelayService(sessions);
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { event_cursor: '1-0' } });
    const lines: any[] = [];
    await relay.streamInteraction({ user_message: 'hi' }, pairingId, mobileSessionId,
      (p) => lines.push(JSON.parse(decrypt(p, key))), () => undefined, new AbortController().signal,
      async () => ({ outcome: 'unreachable', error: 'ECONNREFUSED', cursor: '7-0' }));
    expect(lines[0].client_message_id).toMatch(/^[0-9a-f-]{36}$/); // one is made up when the phone sent none
    expect(lines[1]).toEqual({ _oasis_error: true, retryable: true, body: { error: 'ECONNREFUSED' }, _cursor: '7-0' });
    sessions.destroy();
  });
});

describe('POST /relay/interaction', () => {
  async function serve(relay: RelayService) {
    const app = express();
    app.use(express.json());
    app.use('/relay', createRelayRouter(relay, 20));
    const server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('sends keep-alives while the turn is quiet and stops the turn when the phone disconnects', async () => {
    const { sessions, pairingId, key } = paired();
    const relay = new RelayService(sessions);
    let signal: AbortSignal | null = null;
    jest.spyOn(relay, 'streamInteraction').mockImplementation(async (_b, _p, _s, _w, onDone, sig) => {
      signal = sig!;
      await new Promise<void>(r => sig!.addEventListener('abort', () => r()));
      onDone();
    });
    const { server, url } = await serve(relay);
    const body = encrypt(JSON.stringify({ user_message: 'hi' }), key, pairingId);
    const abort = new AbortController();
    const res = await fetch(`${url}/relay/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    const line = JSON.parse(Buffer.from(first.value!).toString('utf8').split('\n')[0]);
    expect(JSON.parse(decrypt(line, key))).toEqual({ _oasis_keepalive: true });
    abort.abort();
    await new Promise(r => setTimeout(r, 50));
    expect(signal!.aborted).toBe(true);
    server.closeAllConnections();
    server.close();
    sessions.destroy();
  });

  it('ends the stream instead of hanging when something fails after headers are sent', async () => {
    const { sessions, pairingId, key } = paired();
    const relay = new RelayService(sessions);
    jest.spyOn(relay, 'streamInteraction').mockRejectedValue(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, url } = await serve(relay);
    const body = encrypt(JSON.stringify({ user_message: 'hi' }), key, pairingId);
    const res = await fetch(`${url}/relay/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('');
    server.closeAllConnections();
    server.close();
    sessions.destroy();
  });

  it('refuses a payload sealed with another key before streaming anything', async () => {
    const { sessions, pairingId } = paired();
    const relay = new RelayService(sessions);
    const { server, url } = await serve(relay);
    const body = encrypt(JSON.stringify({ user_message: 'hi' }), generateHalfKey().raw, pairingId);
    const res = await fetch(`${url}/relay/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    server.closeAllConnections();
    server.close();
    sessions.destroy();
  });
});
