/**
 * Project role CRUD, Redis-backed with in-memory fallback.
 *
 * Keys: `pr:by-project:<project_id>` (set of role_ids) and
 *       `pr:role:<role_id>` (JSON blob).
 */

import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import { AgentProfilesService, DEFAULT_INTERNAL_PROFILE_ID } from '../agent-profiles/agent-profiles.service';

import {
  PRESET_ROLES,
  type CreateProjectRoleDto,
  type ProjectRole,
  type RoleKind,
  type UpdateProjectRoleDto,
} from './project-roles.types';

function iso(): string { return new Date().toISOString(); }

@Injectable()
export class ProjectRolesService implements OnModuleDestroy {
  private readonly logger = new Logger(ProjectRolesService.name);
  private redis: Redis | null = null;
  private mem = new Map<string, ProjectRole>();

  constructor(private readonly profiles: AgentProfilesService) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });
      this.redis.connect()
        .then(() => this.logger.log(`Redis connected (project-roles) → ${url}`))
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

  private get r(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  /* ── CRUD ─────────────────────────────────────────────────────── */

  async create(dto: CreateProjectRoleDto): Promise<ProjectRole> {
    if (!dto?.project_id) throw new HttpException('project_id is required', HttpStatus.BAD_REQUEST);
    if (!dto?.kind) throw new HttpException('kind is required', HttpStatus.BAD_REQUEST);
    if (dto.kind === 'custom' && !dto.description?.trim()) {
      throw new HttpException('description is required for custom roles', HttpStatus.BAD_REQUEST);
    }
    const preset = dto.kind !== 'custom' ? PRESET_ROLES[dto.kind] : null;
    const name = dto.name?.trim() || preset?.name || 'Untitled role';
    const description = dto.description?.trim() || preset?.description || '';
    // Default binding: the built-in internal Oasis profile. Callers can
    // override by passing `agent_profile_id` explicitly (or `null` via PATCH).
    let agentProfileId = dto.agent_profile_id;
    if (agentProfileId === undefined) {
      try {
        const def = await this.profiles.ensureDefaultInternal();
        agentProfileId = def.profile_id;
      } catch {
        agentProfileId = DEFAULT_INTERNAL_PROFILE_ID;
      }
    }
    const now = iso();
    const role: ProjectRole = {
      role_id: uuidv4(),
      project_id: dto.project_id,
      name,
      kind: dto.kind,
      description,
      agent_profile_id: agentProfileId,
      created_at: now,
      updated_at: now,
    };
    await this.persist(role);
    return role;
  }

  async get(id: string): Promise<ProjectRole> {
    const r = await this.getOrNull(id);
    if (!r) throw new HttpException('role not found', HttpStatus.NOT_FOUND);
    return r;
  }

  async getOrNull(id: string): Promise<ProjectRole | null> {
    const r = this.r;
    if (r) {
      const raw = await r.get(`pr:role:${id}`);
      if (raw) return JSON.parse(raw) as ProjectRole;
    }
    return this.mem.get(id) ?? null;
  }

  async listByProject(projectId: string): Promise<ProjectRole[]> {
    const r = this.r;
    if (r) {
      const ids = await r.smembers(`pr:by-project:${projectId}`);
      if (ids.length === 0) return [];
      const raws = await r.mget(ids.map(id => `pr:role:${id}`));
      return raws
        .filter((x): x is string => !!x)
        .map(x => JSON.parse(x) as ProjectRole)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...this.mem.values()]
      .filter(r => r.project_id === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async update(id: string, patch: UpdateProjectRoleDto): Promise<ProjectRole> {
    const existing = await this.get(id);
    const kind = patch.kind ?? existing.kind;
    if (kind === 'custom' && patch.description !== undefined && !patch.description?.trim()) {
      throw new HttpException('description is required for custom roles', HttpStatus.BAD_REQUEST);
    }
    const next: ProjectRole = {
      ...existing,
      ...patch,
      role_id: existing.role_id,
      project_id: existing.project_id,
      kind,
      created_at: existing.created_at,
      updated_at: iso(),
    };
    await this.persist(next);
    return next;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    this.mem.delete(id);
    const r = this.r;
    if (!r) return;
    await r.multi()
      .del(`pr:role:${id}`)
      .srem(`pr:by-project:${existing.project_id}`, id)
      .exec();
  }

  /** Create one role per preset kind for a project, skipping kinds that
   *  already exist. Returns the full, updated list for the project. */
  async seedPresets(projectId: string): Promise<ProjectRole[]> {
    if (!projectId) throw new HttpException('project_id is required', HttpStatus.BAD_REQUEST);
    const existing = await this.listByProject(projectId);
    const haveKinds = new Set(existing.map(r => r.kind));
    const presetKinds: RoleKind[] = ['researcher', 'developer', 'data_analyst', 'designer'];
    for (const kind of presetKinds) {
      if (!haveKinds.has(kind)) {
        await this.create({ project_id: projectId, kind });
      }
    }
    return this.listByProject(projectId);
  }

  /** When a profile is deleted, scrub its id from any roles that pointed at it. */
  async unbindProfileEverywhere(profileId: string): Promise<number> {
    const r = this.r;
    if (!r) {
      let count = 0;
      for (const role of this.mem.values()) {
        if (role.agent_profile_id === profileId) {
          role.agent_profile_id = undefined;
          role.updated_at = iso();
          count++;
        }
      }
      return count;
    }
    // Slow path: scan keys. Fine at low cardinality; upgrade to a secondary
    // index (profile → [role_id]) if role counts explode.
    const keys = await r.keys('pr:role:*');
    if (keys.length === 0) return 0;
    const raws = await r.mget(keys);
    let count = 0;
    for (let i = 0; i < keys.length; i++) {
      if (!raws[i]) continue;
      const role = JSON.parse(raws[i]!) as ProjectRole;
      if (role.agent_profile_id === profileId) {
        role.agent_profile_id = undefined;
        role.updated_at = iso();
        await r.set(keys[i], JSON.stringify(role));
        this.mem.set(role.role_id, role);
        count++;
      }
    }
    return count;
  }

  /* ── Internals ────────────────────────────────────────────────── */

  private async persist(role: ProjectRole): Promise<void> {
    this.mem.set(role.role_id, role);
    const r = this.r;
    if (!r) return;
    await r.multi()
      .set(`pr:role:${role.role_id}`, JSON.stringify(role))
      .sadd(`pr:by-project:${role.project_id}`, role.role_id)
      .exec();
  }
}
