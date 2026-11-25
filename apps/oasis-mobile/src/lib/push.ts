import type { PairingState } from './types';
import { encrypt } from './crypto';

const DEVICE_ID_KEY = 'mobile-device-id';
const PUSH_PREF_KEY = 'mobile-push-enabled';

/** What the push code needs from the browser, so tests can supply their own. */
export interface PushEnv {
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  notificationPermission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  /** The service worker's push manager, once the worker is active. */
  pushManager: () => Promise<PushManager>;
  randomId: () => string;
}

export function browserPushEnv(): PushEnv {
  return {
    fetch: (...args) => fetch(...args),
    storage: localStorage,
    notificationPermission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    pushManager: async () => (await navigator.serviceWorker.ready).pushManager,
    randomId: () => crypto.randomUUID(),
  };
}

/** Web Push needs a service worker, PushManager and notifications (on iOS: the app added to the Home Screen). */
export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** A random id for this phone, kept across pairings so re-registering replaces the old entry. */
export function getDeviceId(env: Pick<PushEnv, 'storage' | 'randomId'>): string {
  let id = env.storage.getItem(DEVICE_ID_KEY);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = env.randomId();
    env.storage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function isPushPreferred(env: Pick<PushEnv, 'storage'>): boolean {
  return env.storage.getItem(PUSH_PREF_KEY) === '1';
}

export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function fetchPushConfig(pairing: PairingState, env: Pick<PushEnv, 'fetch'>): Promise<{ enabled: boolean; publicKey: string | null }> {
  if (!pairing.tunnelUrl) return { enabled: false, publicKey: null };
  try {
    const res = await env.fetch(`${pairing.tunnelUrl}/relay/push/config`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { enabled: false, publicKey: null };
    const data = await res.json();
    return { enabled: Boolean(data?.enabled && data?.public_key), publicKey: data?.public_key || null };
  } catch {
    return { enabled: false, publicKey: null };
  }
}

async function postEncrypted(pairing: PairingState, path: string, body: unknown, env: Pick<PushEnv, 'fetch'>): Promise<void> {
  if (!pairing.paired || !pairing.sessionKey || !pairing.pairingId || !pairing.tunnelUrl) throw new Error('Not paired');
  const sealed = await encrypt(JSON.stringify(body), pairing.sessionKey, pairing.pairingId);
  const res = await env.fetch(`${pairing.tunnelUrl}/relay/push/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sealed),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
  }
}

/**
 * Turn on mission notifications: ask for permission, subscribe with the
 * desktop's VAPID key and register this phone through the encrypted relay.
 */
export async function enablePush(pairing: PairingState, env: PushEnv = browserPushEnv()): Promise<void> {
  const config = await fetchPushConfig(pairing, env);
  if (!config.enabled || !config.publicKey) throw new Error('Notifications are not set up on the desktop');

  const permission = env.notificationPermission() === 'granted' ? 'granted' : await env.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this app');

  const manager = await env.pushManager();
  const key = urlBase64ToUint8Array(config.publicKey);
  let subscription = await manager.getSubscription();
  // A subscription made with another key (keys rotated on the desktop) can't be used.
  if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }
  if (!subscription) {
    subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  }
  await postEncrypted(pairing, 'subscribe', { device_id: getDeviceId(env), subscription: subscription.toJSON() }, env);
  env.storage.setItem(PUSH_PREF_KEY, '1');
}

/** Turn mission notifications off on the desktop and on this phone. */
export async function disablePush(pairing: PairingState, env: PushEnv = browserPushEnv()): Promise<void> {
  env.storage.removeItem(PUSH_PREF_KEY);
  let firstError: unknown = null;
  try {
    await postEncrypted(pairing, 'unsubscribe', { device_id: getDeviceId(env) }, env);
  } catch (err) {
    firstError = err;
  }
  const manager = await env.pushManager().catch(() => null);
  const subscription = await manager?.getSubscription().catch(() => null);
  await subscription?.unsubscribe().catch(() => undefined);
  if (firstError) throw firstError;
}

export async function sendTestPush(pairing: PairingState, env: PushEnv = browserPushEnv()): Promise<void> {
  await postEncrypted(pairing, 'test', { device_id: getDeviceId(env) }, env);
}

function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === wanted.length && a.every((b, i) => b === wanted[i]);
}
