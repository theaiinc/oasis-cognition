/**
 * Agent profile CRUD, Redis-backed with in-memory fallback.
 *
 * Keys: `ap:profiles` (set of ids) and `ap:profile:<id>` (JSON blob).
 */

import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import type {
  AgentProfile,
  CreateAgentProfileDto,
  UpdateAgentProfileDto,
} from './agent-profiles.types';

function iso(): string { return new Date().toISOString(); }

/** Stable id for the built-in internal Oasis LLM profile. Seeded on boot so it
 *  is always available as the default binding for project roles. */
export const DEFAULT_INTERNAL_PROFILE_ID = 'internal-default';

@Injectable()
export class AgentProfilesService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(AgentProfilesService.name);
  private redis: Redis | null = null;
  private mem = new Map<string, AgentProfile>();

  constructor() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => this.logger.log(`Redis connected (agent-profiles) → ${url}`))
        .catch(err => {
          this.logger.warn(`Redis unavailable: ${err.message}; in-memory fallback`);
          this.redis = null;
        });
      this.redis.on('error', (err) => {
        this.logger.debug(`Redis error (ignored; fallback active): ${err.message}`);
      });
    } catch (err: any) {
      this.logger.warn(`Redis init failed: ${err.message}; in-memory only`);
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    try { await this.redis?.quit(); } catch { /* noop */ }
  }

  async onModuleInit() {
    // Defer slightly so the redis connect promise has a chance to settle; the
    // in-memory fallback works either way.
    setTimeout(() => {
      this.ensureDefaultInternal().catch(err =>
        this.logger.warn(`ensureDefaultInternal failed: ${err?.message || err}`),
      );
    }, 500);
  }

  /** Idempotently ensure the built-in Internal Oasis profile exists. Id is
   *  stable so role bindings survive restarts. */
  async ensureDefaultInternal(): Promise<AgentProfile> {
    const existing = await this.getOrNull(DEFAULT_INTERNAL_PROFILE_ID);
    if (existing) return existing;
    const now = iso();
    const profile: AgentProfile = {
      profile_id: DEFAULT_INTERNAL_PROFILE_ID,
      name: 'Internal Oasis LLM',
      description: 'Built-in Oasis chat LLM. Used as the default for project roles. Spawning via external Agent Runner is coming in v2 — for now this profile runs through the in-app chat pipeline.',
      agent_type: 'internal',
      config: {
        system_prompt_preamble: '',
      },
      created_at: now,
      updated_at: now,
    };
    await this.persist(profile);
    this.logger.log(`Seeded default internal profile: ${DEFAULT_INTERNAL_PROFILE_ID}`);
    return profile;
  }

  private get r(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  /* ── CRUD ─────────────────────────────────────────────────────── */

  async create(dto: CreateAgentProfileDto): Promise<AgentProfile> {
    if (!dto?.name?.trim()) throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    if (!dto?.agent_type) throw new HttpException('agent_type is required', HttpStatus.BAD_REQUEST);
    if (!['internal', 'claude-code', 'cursor-cli'].includes(dto.agent_type)) {
      throw new HttpException(`unsupported agent_type: ${dto.agent_type}`, HttpStatus.BAD_REQUEST);
    }
    const now = iso();
    const profile: AgentProfile = {
      profile_id: uuidv4(),
      name: dto.name.trim(),
      description: dto.description,
      agent_type: dto.agent_type,
      config: dto.config || {},
      created_at: now,
      updated_at: now,
    };
    await this.persist(profile);
    return profile;
  }

  async get(id: string): Promise<AgentProfile> {
    const p = await this.getOrNull(id);
    if (!p) throw new HttpException('profile not found', HttpStatus.NOT_FOUND);
    return p;
  }

  async getOrNull(id: string): Promise<AgentProfile | null> {
    const r = this.r;
    if (r) {
      const raw = await r.get(`ap:profile:${id}`);
      if (raw) return JSON.parse(raw) as AgentProfile;
    }
    return this.mem.get(id) ?? null;
  }

  async list(): Promise<AgentProfile[]> {
    const r = this.r;
    if (r) {
      const ids = await r.smembers('ap:profiles');
      if (ids.length === 0) return [];
      const raws = await r.mget(ids.map(id => `ap:profile:${id}`));
      return raws
        .filter((x): x is string => !!x)
        .map(x => JSON.parse(x) as AgentProfile)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return [...this.mem.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async update(id: string, patch: UpdateAgentProfileDto): Promise<AgentProfile> {
    const existing = await this.get(id);
    const next: AgentProfile = {
      ...existing,
      ...patch,
      profile_id: existing.profile_id,
      agent_type: patch.agent_type ?? existing.agent_type,
      config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
      created_at: existing.created_at,
      updated_at: iso(),
    };
    await this.persist(next);
    return next;
  }

  async delete(id: string): Promise<void> {
    if (id === DEFAULT_INTERNAL_PROFILE_ID) {
      throw new HttpException('the built-in internal profile cannot be deleted', HttpStatus.BAD_REQUEST);
    }
    await this.get(id); // 404 if missing
    this.mem.delete(id);
    const r = this.r;
    if (r) {
      await r.multi()
        .del(`ap:profile:${id}`)
        .srem('ap:profiles', id)
        .exec();
    }
  }

  /* ── Internals ────────────────────────────────────────────────── */

  private async persist(p: AgentProfile): Promise<void> {
    this.mem.set(p.profile_id, p);
    const r = this.r;
    if (!r) return;
    await r.multi()
      .set(`ap:profile:${p.profile_id}`, JSON.stringify(p))
      .sadd('ap:profiles', p.profile_id)
      .exec();
  }
}
