jest.mock('web-push', () => ({ sendNotification: jest.fn() }));
import * as webPush from 'web-push';
import { WebPushSender } from './push-sender';

const send = webPush.sendNotification as jest.Mock;
const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' };
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } };

describe('WebPushSender', () => {
  beforeEach(() => send.mockReset());

  it('sends with the VAPID details, a day of TTL and a timeout', async () => {
    send.mockResolvedValue({ statusCode: 201 });
    await expect(new WebPushSender().send(subscription, '{"a":1}', vapid)).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(subscription, '{"a":1}', expect.objectContaining({
      vapidDetails: { subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv' },
      TTL: 86400, timeout: 10000,
    }));
  });

  it('marks 404 and 410 as gone and other failures as retryable', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));
    await expect(new WebPushSender().send(subscription, 'x', vapid)).resolves.toMatchObject({ ok: false, gone: true, status: 410 });
    send.mockRejectedValueOnce(Object.assign(new Error('Not found'), { statusCode: 404 }));
    await expect(new WebPushSender().send(subscription, 'x', vapid)).resolves.toMatchObject({ ok: false, gone: true });
    send.mockRejectedValueOnce(Object.assign(new Error('Busy'), { statusCode: 429 }));
    await expect(new WebPushSender().send(subscription, 'x', vapid)).resolves.toMatchObject({ ok: false, gone: false, status: 429 });
    send.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(new WebPushSender().send(subscription, 'x', vapid)).resolves.toMatchObject({ ok: false, gone: false, error: 'ECONNRESET' });
  });
});
