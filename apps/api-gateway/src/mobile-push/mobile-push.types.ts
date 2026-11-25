/** A browser's Web Push subscription, as PushSubscription.toJSON() gives it. */
export interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** One phone's registration: who it belongs to and where to push. */
export interface StoredPushSubscription {
  user_id: string;
  device_id: string;
  subscription: WebPushSubscription;
  created_at: string;
}

/** What a phone's service worker receives for a finished mission run. */
export interface MissionRunPush {
  type: 'mission_run';
  mission_id: string;
  goal: string;
  ok: boolean;
  /** First part of the run's result or error, for the notification body. */
  summary: string;
  session_id?: string;
  finished_at?: string;
}

/**
 * Hosts of the browser push services (Chrome/Android, Firefox, Safari/iOS, Edge).
 * The gateway POSTs to whatever endpoint a subscription names, so only these are accepted.
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'push.apple.com',
  'notify.windows.com',
];

export function isPushServiceEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

/** The subscription, cleaned, or null when it isn't a usable Web Push subscription. */
export function parseSubscription(raw: any): WebPushSubscription | null {
  if (!raw || typeof raw !== 'object') return null;
  const { endpoint, keys } = raw;
  if (!isPushServiceEndpoint(endpoint)) return null;
  const b64url = /^[A-Za-z0-9_-]+={0,2}$/;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (!b64url.test(keys.p256dh) || !b64url.test(keys.auth) || keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  const expirationTime = typeof raw.expirationTime === 'number' ? raw.expirationTime : null;
  return { endpoint, expirationTime, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Device ids are random ids the phone made for itself. */
export function isDeviceId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}
