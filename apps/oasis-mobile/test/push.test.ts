import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { decrypt, deriveSessionKey } from '../src/lib/crypto';
import { disablePush, enablePush, getDeviceId, urlBase64ToUint8Array, type PushEnv } from '../src/lib/push';
import type { PairingState } from '../src/lib/types';

const PUBLIC_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

async function setup(opts: { configured?: boolean; permission?: NotificationPermission; grant?: NotificationPermission; existingKey?: Uint8Array | null } = {}) {
  const key = await deriveSessionKey(new Uint8Array(32).fill(3).buffer, new Uint8Array(32).fill(4).buffer);
  const pairing: PairingState = { paired: true, tunnelUrl: 'https://tunnel.test', sessionKey: key, pairingId: 'pid', mobileSessionId: 'm', expiresAt: new Date(Date.now() + 1e6) };
  const store = new Map<string, string>();
  const subJson = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } };
  const unsubscribe = vi.fn(async () => true);
  const existing = opts.existingKey === undefined ? null : opts.existingKey === null ? null
    : { options: { applicationServerKey: opts.existingKey.buffer }, toJSON: () => subJson, unsubscribe };
  let current: any = existing;
  const manager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (o: PushSubscriptionOptionsInit) => {
      current = { options: o, toJSON: () => subJson, unsubscribe };
      return current;
    }),
  };
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/relay/push/config')) {
      return new Response(JSON.stringify(opts.configured === false ? { enabled: false, public_key: null } : { enabled: true, public_key: PUBLIC_KEY }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  const env: PushEnv = {
    fetch: fetchMock as any,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    notificationPermission: () => opts.permission ?? 'default',
    requestPermission: vi.fn(async () => opts.grant ?? 'granted'),
    pushManager: async () => manager as any,
    randomId: () => 'device-0001',
  };
  const posted = async (suffix: string) => {
    const call = fetchMock.mock.calls.find(([u]) => u.endsWith(suffix));
    return call ? JSON.parse(await decrypt(JSON.parse(call[1]!.body as string), key)) : null;
  };
  return { pairing, env, manager, fetchMock, unsubscribe, store, posted };
}

describe('push opt-in', () => {
  it('asks permission, subscribes with the desktop key and registers through the encrypted relay', async () => {
    const { pairing, env, manager, posted, store } = await setup();
    await enablePush(pairing, env);
    expect(env.requestPermission).toHaveBeenCalled();
    const opts = manager.subscribe.mock.calls[0][0];
    expect(opts.userVisibleOnly).toBe(true);
    expect(Array.from(opts.applicationServerKey as Uint8Array)).toEqual(Array.from(urlBase64ToUint8Array(PUBLIC_KEY)));
    expect(await posted('/relay/push/subscribe')).toEqual({
      device_id: 'device-0001',
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(store.get('mobile-push-enabled')).toBe('1');
  });

  it('stops when the desktop has no keys or the user says no', async () => {
    const off = await setup({ configured: false });
    await expect(enablePush(off.pairing, off.env)).rejects.toThrow('not set up');
    expect(off.manager.subscribe).not.toHaveBeenCalled();
    const denied = await setup({ grant: 'denied' });
    await expect(enablePush(denied.pairing, denied.env)).rejects.toThrow('blocked');
    expect(denied.manager.subscribe).not.toHaveBeenCalled();
    expect(denied.fetchMock.mock.calls.some(([u]) => u.endsWith('/subscribe'))).toBe(false);
  });

  it('reuses a subscription made with the same key, replaces one made with an old key', async () => {
    const same = await setup({ permission: 'granted', existingKey: urlBase64ToUint8Array(PUBLIC_KEY) });
    await enablePush(same.pairing, same.env);
    expect(same.manager.subscribe).not.toHaveBeenCalled();
    expect(same.env.requestPermission).not.toHaveBeenCalled();

    const rotated = await setup({ permission: 'granted', existingKey: new Uint8Array(65).fill(1) });
    await enablePush(rotated.pairing, rotated.env);
    expect(rotated.unsubscribe).toHaveBeenCalled();
    expect(rotated.manager.subscribe).toHaveBeenCalled();
  });

  it('turns off on the desktop and in the browser', async () => {
    const { pairing, env, posted, unsubscribe, store } = await setup({ permission: 'granted', existingKey: urlBase64ToUint8Array(PUBLIC_KEY) });
    await enablePush(pairing, env);
    await disablePush(pairing, env);
    expect(await posted('/relay/push/unsubscribe')).toEqual({ device_id: 'device-0001' });
    expect(unsubscribe).toHaveBeenCalled();
    expect(store.has('mobile-push-enabled')).toBe(false);
  });

  it('keeps one device id per phone', () => {
    const store = new Map<string, string>();
    const env = { storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: () => undefined }, randomId: vi.fn(() => 'abcdef12-3456') };
    expect(getDeviceId(env)).toBe('abcdef12-3456');
    expect(getDeviceId(env)).toBe('abcdef12-3456');
    expect(env.randomId).toHaveBeenCalledTimes(1);
  });
});

describe('service worker push handler', () => {
  function loadWorker() {
    const listeners: Record<string, (e: any) => void> = {};
    const showNotification = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => undefined);
    let windows: any[] = [];
    const self: any = { addEventListener: (t: string, fn: any) => { listeners[t] = fn; }, registration: { showNotification } };
    const ctx = vm.createContext({ self, clients: { matchAll: async () => windows, openWindow } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/push-sw.js'), 'utf8'), ctx);
    const dispatch = async (type: string, event: any) => {
      let wait: Promise<unknown> = Promise.resolve();
      listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { wait = p; } });
      await wait;
    };
    return { dispatch, showNotification, focus, openWindow, setWindows: (w: any[]) => { windows = w; } };
  }

  it('shows a mission digest with its goal and result', async () => {
    const w = loadWorker();
    await w.dispatch('push', { data: { json: () => ({ type: 'mission_run', mission_id: 'm1', goal: 'Watch the inbox', ok: true, summary: '3 new emails' }) } });
    expect(w.showNotification).toHaveBeenCalledWith('Watch the inbox', expect.objectContaining({ body: '3 new emails', tag: 'mission-m1' }));
    await w.dispatch('push', { data: { json: () => ({ type: 'mission_run', mission_id: 'm2', goal: 'Backup', ok: false, summary: 'disk full' }) } });
    expect(w.showNotification).toHaveBeenLastCalledWith('Backup', expect.objectContaining({ body: 'Failed: disk full' }));
  });

  it('still shows something for an unreadable push (browsers require it)', async () => {
    const w = loadWorker();
    await w.dispatch('push', { data: { json: () => { throw new Error('bad'); } } });
    expect(w.showNotification).toHaveBeenCalledTimes(1);
  });

  it('focuses an open window on tap, or opens one', async () => {
    const w = loadWorker();
    const close = vi.fn();
    await w.dispatch('notificationclick', { notification: { close, data: { url: '/' } } });
    expect(w.openWindow).toHaveBeenCalledWith('/');
    w.setWindows([{ focus: w.focus }]);
    await w.dispatch('notificationclick', { notification: { close, data: { url: '/' } } });
    expect(w.focus).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
