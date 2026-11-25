import * as webPush from 'web-push';
import type { WebPushSubscription } from './mobile-push.types';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * VAPID keys come from the environment only. Push is off unless all three are set.
 * Generate a pair with `npx web-push generate-vapid-keys`.
 */
export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = (env.MOBILE_PUSH_VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (env.MOBILE_PUSH_VAPID_PRIVATE_KEY || '').trim();
  const subject = (env.MOBILE_PUSH_VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; status?: number; error: string };

/** Sends one push. Swappable so tests never reach a real push service. */
export interface PushSender {
  send(subscription: WebPushSubscription, payload: string, vapid: VapidConfig): Promise<SendResult>;
}

export class WebPushSender implements PushSender {
  async send(subscription: WebPushSubscription, payload: string, vapid: VapidConfig): Promise<SendResult> {
    try {
      await webPush.sendNotification(subscription as webPush.PushSubscription, payload, {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 24 * 60 * 60,
        urgency: 'normal',
        timeout: 10_000,
      });
      return { ok: true };
    } catch (err: any) {
      const status: number | undefined = err?.statusCode;
      // 404/410: the browser dropped the subscription, so it never comes back.
      return { ok: false, gone: status === 404 || status === 410, status, error: err?.message || String(err) };
    }
  }
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');
