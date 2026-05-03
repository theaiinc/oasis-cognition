import { Injectable, Logger, OnModuleDestroy, OnModuleInit, HttpException, HttpStatus, Inject, forwardRef } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { RedisEventService } from '../events/redis-event.service';
import { InteractionService } from '../interaction/interaction.service';
import type { CreateMissionDto, Mission, UpdateMissionDto } from './missions.types';

// cron-parser CJS interop (matches how triggers.service.ts does it).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser: { parseExpression: (expr: string, opts?: { tz?: string }) => any } = require('cron-parser');

const REDIS_KEY = 'oasis:missions';

/**
 * Mission scheduler + run executor. Uses an in-process setTimeout-driven cron
 * (one timer per enabled mission) rather than BullMQ — missions are a single-process
 * concern in this app, BullMQ would be overkill, and this keeps the dependency
 * surface tight.
 *
 * On every tick we call InteractionService.execute() with the mission's prompt.
 * The mission has its own session_id, so its chat history accumulates separately
 * from the user's main thread; we publish a `MissionRunCompleted` event to the
 * mission's notify_session_id so a digest card surfaces in the chat that owns it.
 */
@Injectable()
export class MissionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MissionsService.name);
  private redis: Redis | null = null;
  private redisReady = false;
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly memCache = new Map<string, Mission>();

  constructor(
    private readonly events: RedisEventService,
    // forwardRef because Missions and Interactions could grow circular bindings later
    // (e.g. InteractionService might want to inspect missions for tool calls).
    @Inject(forwardRef(() => InteractionService))
    private readonly interaction: InteractionService,
  ) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => { this.redisReady = true; })
        .catch(() => this.logger.warn('Redis unavailable; missions held in memory only'));
    } catch {
      this.logger.warn('Redis init failed; missions held in memory only');
    }
  }

  async onModuleInit() {
    // Hydrate missions and (re)schedule any that are enabled. Reset any
    // mission stuck in `state: 'running'` — that means the previous gateway
    // process died mid-tick. Without this reset, the mission's tick guard
    // ("already running, skipping") would silently disable it forever.
    try {
      const all = await this.list();
      for (const m of all) {
        if (m.state === 'running') {
          this.logger.log(`Resetting mission ${m.mission_id} from 'running' → 'idle' (gateway restart recovery)`);
          await this.persist({ ...m, state: 'idle' });
        }
        if (m.enabled && m.state !== 'paused') this.schedule(m);
      }
      this.logger.log(`MissionsService: ${all.length} loaded, ${this.timers.size} scheduled`);
    } catch (err: any) {
      this.logger.warn(`Failed to hydrate missions: ${err?.message || err}`);
    }
  }

  async onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  // ── CRUD ────────────────────────────────────────────────────────

  async create(dto: CreateMissionDto): Promise<Mission> {
    if (!dto.goal?.trim()) throw new HttpException('goal is required', HttpStatus.BAD_REQUEST);
    if (!dto.schedule?.trim()) throw new HttpException('schedule (cron) is required', HttpStatus.BAD_REQUEST);
    this.validateSchedule(dto.schedule);

    const now = new Date().toISOString();
    const id = uuidv4();
    const mission: Mission = {
      mission_id: id,
      goal: dto.goal.trim(),
      prompt: (dto.prompt ?? dto.goal).trim(),
      schedule: dto.schedule.trim(),
      enabled: dto.enabled ?? true,
      session_id: `mission-${id.slice(0, 8)}`,
      notify_session_id: dto.notify_session_id ?? null,
      role_id: dto.role_id,
      profile_id: dto.profile_id,
      connector_id: dto.connector_id,
      state: 'idle',
      run_count: 0,
      created_at: now,
      updated_at: now,
    };
    await this.persist(mission);
    if (mission.enabled) this.schedule(mission);
    await this.publishLifecycle(mission, 'MissionCreated');
    return mission;
  }

  async list(): Promise<Mission[]> {
    if (this.redis && this.redisReady) {
      try {
        const map = await this.redis.hgetall(REDIS_KEY);
        const out: Mission[] = [];
        for (const v of Object.values(map)) {
          try { out.push(JSON.parse(v) as Mission); } catch { /* skip corrupt */ }
        }
        // refresh memcache
        for (const m of out) this.memCache.set(m.mission_id, m);
        return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
      } catch (err) {
        this.logger.warn(`list redis failed: ${err}`);
      }
    }
    return Array.from(this.memCache.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(id: string): Promise<Mission | null> {
    if (this.memCache.has(id)) return this.memCache.get(id)!;
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.hget(REDIS_KEY, id);
        if (v) {
          const m = JSON.parse(v) as Mission;
          this.memCache.set(id, m);
          return m;
        }
      } catch (err) {
        this.logger.warn(`get redis failed: ${err}`);
      }
    }
    return null;
  }

  async update(id: string, patch: UpdateMissionDto): Promise<Mission> {
    const prev = await this.get(id);
    if (!prev) throw new HttpException('mission not found', HttpStatus.NOT_FOUND);
    if (patch.schedule) this.validateSchedule(patch.schedule);
    const next: Mission = {
      ...prev,
      ...patch,
      mission_id: prev.mission_id,
      session_id: prev.session_id,
      run_count: prev.run_count,
      created_at: prev.created_at,
      updated_at: new Date().toISOString(),
    };
    await this.persist(next);
    // Re-schedule (clear old timer; arm new one only if enabled).
    this.clearTimer(id);
    if (next.enabled && next.state !== 'paused') this.schedule(next);
    await this.publishLifecycle(next, 'MissionUpdated');
    return next;
  }

  async remove(id: string): Promise<void> {
    const prev = await this.get(id);
    if (!prev) return;
    this.clearTimer(id);
    this.memCache.delete(id);
    if (this.redis && this.redisReady) {
      try { await this.redis.hdel(REDIS_KEY, id); } catch (err) { this.logger.warn(`remove redis failed: ${err}`); }
    }
    await this.publishLifecycle(prev, 'MissionDeleted');
  }

  async pause(id: string): Promise<Mission> {
    const prev = await this.get(id);
    if (!prev) throw new HttpException('mission not found', HttpStatus.NOT_FOUND);
    this.clearTimer(id);
    const next: Mission = { ...prev, enabled: false, state: 'paused', updated_at: new Date().toISOString() };
    await this.persist(next);
    await this.publishLifecycle(next, 'MissionUpdated');
    return next;
  }

  async resume(id: string): Promise<Mission> {
    const prev = await this.get(id);
    if (!prev) throw new HttpException('mission not found', HttpStatus.NOT_FOUND);
    const next: Mission = { ...prev, enabled: true, state: 'idle', updated_at: new Date().toISOString() };
    await this.persist(next);
    this.schedule(next);
    await this.publishLifecycle(next, 'MissionUpdated');
    return next;
  }

  /** Fire a mission immediately; schedule keeps running on its normal cadence. */
  async runOnce(id: string): Promise<Mission> {
    const m = await this.get(id);
    if (!m) throw new HttpException('mission not found', HttpStatus.NOT_FOUND);
    void this.tick(id, { triggeredBy: 'manual' });
    return m;
  }

  // ── Scheduling ──────────────────────────────────────────────────

  private validateSchedule(expr: string) {
    try { parser.parseExpression(expr); }
    catch (err: any) {
      throw new HttpException(`invalid cron schedule: ${err?.message || err}`, HttpStatus.BAD_REQUEST);
    }
  }

  private clearTimer(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private schedule(m: Mission) {
    this.clearTimer(m.mission_id);
    let nextDate: Date;
    try {
      nextDate = parser.parseExpression(m.schedule).next().toDate();
    } catch (err) {
      this.logger.warn(`Cannot schedule mission ${m.mission_id}: ${err}`);
      return;
    }
    const fullDelay = Math.max(50, nextDate.getTime() - Date.now());
    // setTimeout's int32 cap (~24.8 days) silently treats overflow as 0, which
    // fires the timer immediately — an infinite-tick footgun for cron expressions
    // like "0 0 1 1 *". Cap at 24 days; when the cap fires, re-evaluate.
    const MAX_TIMER_MS = 24 * 24 * 60 * 60 * 1000; // 24 days
    const delay = Math.min(fullDelay, MAX_TIMER_MS);
    const willFireEarly = delay < fullDelay;
    // Persist next_run_at for the UI without going through update() — that path
    // calls clearTimer + schedule() again, which would recurse infinitely and
    // emit a MissionUpdated for every run-arming. persist() is the side-effect-free
    // write we want here.
    void this.persist(m).catch(() => undefined);
    const timer = setTimeout(() => {
      if (willFireEarly) {
        // Re-arm; we haven't actually reached the cron's next beat yet.
        void this.persist(m).then(() => this.schedule(m)).catch(() => undefined);
        return;
      }
      void this.tick(m.mission_id, { triggeredBy: 'schedule' });
    }, delay);
    this.timers.set(m.mission_id, timer);
  }

  /** Execute a mission run: send the prompt to the agent in the mission's session, capture result, publish digest. */
  private async tick(missionId: string, opts: { triggeredBy: 'schedule' | 'manual' }) {
    const m = await this.get(missionId);
    if (!m) return;
    if (m.state === 'running') {
      this.logger.warn(`tick: mission ${missionId} already running, skipping`);
      // Reschedule for next cron beat anyway.
      if (m.enabled && opts.triggeredBy === 'schedule') this.schedule(m);
      return;
    }

    const startedAt = new Date().toISOString();
    await this.persist({ ...m, state: 'running' });
    await this.events.publish('MissionRunStarted', m.notify_session_id || m.session_id, {
      mission_id: m.mission_id,
      goal: m.goal,
      triggered_by: opts.triggeredBy,
      started_at: startedAt,
    });

    let result = '';
    let error: string | null = null;
    try {
      const out = await this.interaction.execute({
        user_message: m.prompt,
        session_id: m.session_id,
        role_id: m.role_id,
        profile_id: m.profile_id,
        context: { mission_id: m.mission_id, mission_goal: m.goal },
      });
      result = out.response || '';
    } catch (err: any) {
      error = err?.message || String(err);
      this.logger.warn(`Mission ${missionId} failed: ${error}`);
    }

    const finishedAt = new Date().toISOString();
    const finished: Mission = {
      ...m,
      state: error ? 'failed' : 'idle',
      last_run_at: finishedAt,
      last_result: error ? undefined : truncate(result, 4000),
      last_error: error ?? undefined,
      run_count: m.run_count + 1,
    };
    await this.persist(finished);

    // Digest card → user's main chat session (if set), fall back to the mission's own session.
    const digestSession = m.notify_session_id || m.session_id;
    await this.events.publish('MissionRunCompleted', digestSession, {
      mission_id: m.mission_id,
      goal: m.goal,
      session_id: m.session_id,
      result: finished.last_result,
      error: finished.last_error,
      run_count: finished.run_count,
      started_at: startedAt,
      finished_at: finishedAt,
      triggered_by: opts.triggeredBy,
    });

    // Re-arm timer for next cron beat (only when this run was scheduled — manual runs don't re-arm).
    if (finished.enabled && opts.triggeredBy === 'schedule') {
      this.schedule(finished);
    } else if (finished.enabled) {
      // Manual run: keep the existing schedule alive by re-scheduling from now.
      this.schedule(finished);
    }
  }

  private async persist(m: Mission): Promise<void> {
    let next: Mission = m;
    try {
      const expr = parser.parseExpression(m.schedule);
      next = { ...m, next_run_at: expr.next().toDate().toISOString() };
    } catch { /* leave next_run_at unset */ }
    this.memCache.set(next.mission_id, next);
    if (this.redis && this.redisReady) {
      try { await this.redis.hset(REDIS_KEY, next.mission_id, JSON.stringify(next)); }
      catch (err) { this.logger.warn(`persist redis failed: ${err}`); }
    }
  }

  private async publishLifecycle(m: Mission, eventType: 'MissionCreated' | 'MissionUpdated' | 'MissionDeleted') {
    const target = m.notify_session_id || m.session_id;
    await this.events.publish(eventType, target, {
      mission_id: m.mission_id,
      goal: m.goal,
      schedule: m.schedule,
      enabled: m.enabled,
      state: m.state,
      next_run_at: m.next_run_at,
    });
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '\n…[truncated]';
}
