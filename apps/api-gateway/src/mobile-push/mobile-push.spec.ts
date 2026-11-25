import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MobilePushController, PUSH_OWNER } from './mobile-push.controller';
import { MobilePushService } from './mobile-push.service';
import { MemoryHash, PushSubscriptionStore } from './push-subscription.store';
import { vapidFromEnv, type PushSender } from './push-sender';
import { isPushServiceEndpoint, parseSubscription } from './mobile-push.types';

const VAPID_ENV = {
  MOBILE_PUSH_VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
  MOBILE_PUSH_VAPID_PRIVATE_KEY: 'privateKeyForTests',
  MOBILE_PUSH_VAPID_SUBJECT: 'mailto:ops@example.com',
} as NodeJS.ProcessEnv;

const sub = (n = 1) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  expirationTime: null,
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
});

function setup(opts: { env?: NodeJS.ProcessEnv } = {}) {
  let listener: ((e: any) => void) | null = null;
  const events = {
    onEvent: jest.fn((fn) => { listener = fn; return () => { listener = null; }; }),
  };
  const sender: jest.Mocked<PushSender> = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const store = new PushSubscriptionStore().useBackend(new MemoryHash());
  const service = new MobilePushService(events as any, store, sender, opts.env ?? VAPID_ENV);
  service.onModuleInit();
  const controller = new MobilePushController(service);
  return { service, controller, store, sender, events, emit: (e: any) => listener?.(e) };
}

const flush = () => new Promise(r => setImmediate(r));

describe('VAPID config', () => {
  it('is off unless public key, private key and subject are all set', () => {
    expect(vapidFromEnv({} as any)).toBeNull();
    expect(vapidFromEnv({ ...VAPID_ENV, MOBILE_PUSH_VAPID_PRIVATE_KEY: '' })).toBeNull();
    expect(vapidFromEnv({ ...VAPID_ENV, MOBILE_PUSH_VAPID_SUBJECT: 'ops@example.com' })).toBeNull();
    expect(vapidFromEnv(VAPID_ENV)).toEqual({ publicKey: 'BPublicKeyForTests', privateKey: 'privateKeyForTests', subject: 'mailto:ops@example.com' });
  });

  it('turns registration off and never listens for missions without keys', async () => {
    const { controller, events, sender } = setup({ env: {} as any });
    expect(controller.config()).toEqual({ enabled: false, public_key: null });
    expect(events.onEvent).not.toHaveBeenCalled();
    await expect(controller.subscribe({ device_id: 'device-0001', subscription: sub() })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe('subscription registration', () => {
  it('accepts only push-service endpoints with proper keys', () => {
    expect(isPushServiceEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushServiceEndpoint('https://web.push.apple.com/QW')).toBe(true);
    expect(isPushServiceEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushServiceEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isPushServiceEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isPushServiceEndpoint('https://fcm.googleapis.com.evil.test/x')).toBe(false);
    expect(isPushServiceEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(parseSubscription({ endpoint: sub().endpoint, keys: { p256dh: 'not base64!', auth: 'x' } })).toBeNull();
    expect(parseSubscription(sub())).toEqual(sub());
  });

  it('stores one registration per device, replacing on re-register', async () => {
    const { controller, store } = setup();
    await controller.subscribe({ device_id: 'phone-aaaa', subscription: sub(1) });
    await controller.subscribe({ device_id: 'phone-aaaa', subscription: sub(2) });
    await controller.subscribe({ device_id: 'phone-bbbb', subscription: sub(3) });
    const all = await store.list(PUSH_OWNER);
    expect(all.map(e => [e.device_id, e.subscription.endpoint]).sort()).toEqual([
      ['phone-aaaa', sub(2).endpoint], ['phone-bbbb', sub(3).endpoint],
    ]);
    await expect(controller.unsubscribe('phone-aaaa')).resolves.toEqual({ ok: true, removed: true });
    await expect(controller.unsubscribe('phone-aaaa')).resolves.toEqual({ ok: true, removed: false });
    expect((await store.list(PUSH_OWNER)).map(e => e.device_id)).toEqual(['phone-bbbb']);
  });

  it('rejects bad device ids and subscriptions', async () => {
    const { controller } = setup();
    await expect(controller.subscribe({ device_id: 'x', subscription: sub() })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.subscribe({ device_id: 'phone-aaaa', subscription: { endpoint: 'https://example.com/x', keys: sub().keys } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.unsubscribe('../../etc')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('mission digests', () => {
  it('pushes a finished run to every registered device', async () => {
    const { controller, sender, emit } = setup();
    await controller.subscribe({ device_id: 'phone-aaaa', subscription: sub(1) });
    await controller.subscribe({ device_id: 'phone-bbbb', subscription: sub(2) });
    emit({ event_type: 'MissionRunCompleted', session_id: 'chat-1', payload: {
      mission_id: 'm1', goal: 'Watch the build', result: 'Three new   failures\nin the api tests', session_id: 'mission-m1', finished_at: '2026-11-25T10:00:00Z',
    } });
    await flush(); await flush();
    expect(sender.send).toHaveBeenCalledTimes(2);
    const [target, body, vapid] = sender.send.mock.calls[0];
    expect([sub(1).endpoint, sub(2).endpoint]).toContain(target.endpoint);
    expect(JSON.parse(body)).toEqual({
      type: 'mission_run', mission_id: 'm1', goal: 'Watch the build', ok: true,
      summary: 'Three new failures in the api tests', session_id: 'mission-m1', finished_at: '2026-11-25T10:00:00Z',
    });
    expect(vapid.subject).toBe('mailto:ops@example.com');
  });

  it('ignores other events, reports failures, and clips long results', async () => {
    const { service, controller, sender, emit } = setup();
    await controller.subscribe({ device_id: 'phone-aaaa', subscription: sub(1) });
    emit({ event_type: 'MissionRunStarted', session_id: 's', payload: {} });
    await flush();
    expect(sender.send).not.toHaveBeenCalled();
    await service.notifyMissionRun('s', { mission_id: 'm1', goal: 'g', error: 'x'.repeat(500) });
    const body = JSON.parse(sender.send.mock.calls[0][1]);
    expect(body.ok).toBe(false);
    expect(body.summary.length).toBe(140);
  });

  it('drops subscriptions the push service says are gone, keeps ones that failed for a while', async () => {
    const { service, controller, sender, store } = setup();
    await controller.subscribe({ device_id: 'phone-gone', subscription: sub(1) });
    await controller.subscribe({ device_id: 'phone-down', subscription: sub(2) });
    sender.send.mockImplementation(async (s) => s.endpoint === sub(1).endpoint
      ? { ok: false, gone: true, status: 410, error: 'Gone' }
      : { ok: false, gone: false, status: 503, error: 'Unavailable' });
    await expect(service.notifyMissionRun('s', { mission_id: 'm', goal: 'g' })).resolves.toBe(0);
    expect((await store.list(PUSH_OWNER)).map(e => e.device_id)).toEqual(['phone-down']);
  });

  it('sends a test notification to a registered device', async () => {
    const { controller, sender } = setup();
    await controller.subscribe({ device_id: 'phone-aaaa', subscription: sub(1) });
    await expect(controller.test('phone-aaaa')).resolves.toEqual({ ok: true });
    await expect(controller.test('phone-zzzz')).rejects.toThrow('device_not_registered');
    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});

describe('module wiring', () => {
  it('resolves through Nest with the real sender and env config', async () => {
    const { Test } = await import('@nestjs/testing');
    const { RedisEventService } = await import('../events/redis-event.service');
    const { MobilePushModule } = await import('./mobile-push.module');
    const { Global, Module } = await import('@nestjs/common');
    const events = { onEvent: jest.fn(() => () => undefined) };
    @Global() @Module({ providers: [{ provide: RedisEventService, useValue: events }], exports: [RedisEventService] })
    class FakeEvents {}
    const moduleRef = await Test.createTestingModule({ imports: [FakeEvents, MobilePushModule] }).compile();
    const service = moduleRef.get(MobilePushService);
    expect(typeof service.enabled).toBe('boolean');
    await moduleRef.close();
  });
});
