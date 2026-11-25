import axios from 'axios';
import { SessionService } from '../src/session/session.service';
import { RelayService } from '../src/relay/relay.service';
import { generateHalfKey } from '../src/crypto/crypto.service';

afterEach(() => jest.restoreAllMocks());

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } };

describe('push registration through the relay', () => {
  it('registers the paired phone with the gateway and removes it when the pairing ends', async () => {
    const sessions = new SessionService();
    const { pairingId } = sessions.initiatePairing('https://tunnel.example', 1);
    sessions.completePairing(pairingId, generateHalfKey().encoded);
    const relay = new RelayService(sessions);
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
    const del = jest.spyOn(axios, 'delete').mockResolvedValue({ data: { ok: true } });
    const ended: Array<string | null> = [];
    sessions.onSessionEnded(({ pushDeviceId }) => {
      ended.push(pushDeviceId);
      if (pushDeviceId) void relay.unregisterPush(pushDeviceId);
    });

    await relay.registerPush('phone-1234', subscription);
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/mobile-push\/subscriptions$/), { device_id: 'phone-1234', subscription }, expect.anything());
    expect(sessions.getActiveSession()!.pushDeviceId).toBe('phone-1234');

    sessions.revoke();
    await new Promise(r => setImmediate(r));
    expect(ended).toEqual(['phone-1234']);
    expect(del).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/mobile-push\/subscriptions\/phone-1234$/), expect.anything());
    sessions.destroy();
  });

  it('reports push as off when the gateway has no keys or is unreachable', async () => {
    const sessions = new SessionService();
    const relay = new RelayService(sessions);
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: { enabled: false, public_key: null } });
    await expect(relay.getPushConfig()).resolves.toEqual({ enabled: false, public_key: null });
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: { enabled: true, public_key: 'BKey' } });
    await expect(relay.getPushConfig()).resolves.toEqual({ enabled: true, public_key: 'BKey' });
    sessions.destroy();
  });
});
