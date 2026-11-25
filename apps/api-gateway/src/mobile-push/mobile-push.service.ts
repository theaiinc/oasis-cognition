import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { RedisEventService } from '../events/redis-event.service';
import { PushSubscriptionStore } from './push-subscription.store';
import { PUSH_SENDER, PushSender, VapidConfig, WebPushSender, vapidFromEnv } from './push-sender';
import type { MissionRunPush, StoredPushSubscription, WebPushSubscription } from './mobile-push.types';

const SUMMARY_CHARS = 140;

/**
 * Web Push to paired phones. When a mission run finishes (MissionRunCompleted),
 * every registered phone gets a notification with the mission's goal and the
 * start of its result. Off when the VAPID env vars aren't set.
 */
@Injectable()
export class MobilePushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MobilePushService.name);
  private stop?: () => void;
  private readonly vapid: VapidConfig | null;
  private readonly sender: PushSender;

  constructor(
    private readonly events: RedisEventService,
    private readonly store: PushSubscriptionStore,
    @Optional() @Inject(PUSH_SENDER) sender?: PushSender,
    @Optional() @Inject('MOBILE_PUSH_ENV') env?: NodeJS.ProcessEnv,
  ) {
    this.vapid = vapidFromEnv(env || process.env);
    this.sender = sender || new WebPushSender();
  }

  onModuleInit(): void {
    if (!this.vapid) {
      this.logger.log('Mobile push is off (MOBILE_PUSH_VAPID_* not set)');
      return;
    }
    this.stop = this.events.onEvent((event) => {
      if (event.event_type !== 'MissionRunCompleted') return;
      void this.notifyMissionRun(event.session_id, event.payload || {}).catch((err) =>
        this.logger.warn(`Mission push failed: ${err?.message || err}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.stop?.();
  }

  get enabled(): boolean {
    return this.vapid !== null;
  }

  get publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  async register(userId: string, deviceId: string, subscription: WebPushSubscription): Promise<void> {
    await this.store.save({ user_id: userId, device_id: deviceId, subscription, created_at: new Date().toISOString() });
  }

  unregister(userId: string, deviceId: string): Promise<boolean> {
    return this.store.remove(userId, deviceId);
  }

  /** Sends a test notification to one of the user's devices; false when it isn't registered. */
  async sendTest(userId: string, deviceId: string): Promise<boolean> {
    const entry = (await this.store.list(userId)).find(e => e.device_id === deviceId);
    if (!entry || !this.vapid) return false;
    const payload: MissionRunPush = { type: 'mission_run', mission_id: 'test', goal: 'Test notification', ok: true, summary: 'Notifications are working.' };
    await this.deliver([entry], payload);
    return true;
  }

  /** A mission's digest goes to every registered phone (this gateway has a single owner). */
  async notifyMissionRun(_sessionId: string, payload: Record<string, any>): Promise<number> {
    if (!this.vapid) return 0;
    const targets = await this.store.list(null);
    if (!targets.length) return 0;
    const message: MissionRunPush = {
      type: 'mission_run',
      mission_id: String(payload.mission_id || ''),
      goal: clip(String(payload.goal || ''), 120),
      ok: !payload.error,
      summary: clip(String(payload.error || payload.result || ''), SUMMARY_CHARS),
      ...(payload.session_id ? { session_id: String(payload.session_id) } : {}),
      ...(payload.finished_at ? { finished_at: String(payload.finished_at) } : {}),
    };
    return this.deliver(targets, message);
  }

  private async deliver(targets: StoredPushSubscription[], message: MissionRunPush): Promise<number> {
    const body = JSON.stringify(message);
    let sent = 0;
    await Promise.all(targets.map(async (t) => {
      const res = await this.sender.send(t.subscription, body, this.vapid!);
      if (res.ok) { sent++; return; }
      if (res.gone) {
        await this.store.remove(t.user_id, t.device_id).catch(() => undefined);
        this.logger.log(`Dropped an expired push subscription (device ${t.device_id})`);
      } else {
        this.logger.warn(`Push to device ${t.device_id} failed (${res.status ?? 'network'}): ${res.error}`);
      }
    }));
    return sent;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
