/**
 * Knowledge packs: export a project's own rules to versioned JSON, and import a pack
 * back into a project without duplicates (memory-service/knowledge_pack.py does the
 * merging). The project comes from the request, never from the pack: project ids
 * inside a pack are ignored.
 */

import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';

const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';

/** The pack version this gateway sends on; memory-service checks it again. */
export const KNOWLEDGE_PACK_SCHEMA_VERSION = 1;

export interface KnowledgePackStore {
  exportPack(projectId: string, name: string): Promise<unknown>;
  importPack(projectId: string, pack: unknown): Promise<unknown>;
}

function memoryError(err: any): never {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (status && status < 500) throw new HttpException(typeof detail === 'string' ? detail : 'knowledge_pack_rejected', status);
  throw new ServiceUnavailableException('memory_service_unavailable');
}

export const httpKnowledgePackStore: KnowledgePackStore = {
  async exportPack(projectId, name) {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/knowledge-packs/export`, {
        params: { project_id: projectId, name }, timeout: 20000,
      });
      return res.data;
    } catch (err) { return memoryError(err); }
  },
  async importPack(projectId, pack) {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/knowledge-packs/import`, {
        pack, project_id: projectId,
      }, { timeout: 60000 });
      return res.data;
    } catch (err) { return memoryError(err); }
  },
};

/** What is wrong with an uploaded pack before it goes to memory-service, or null. */
export function packProblem(pack: unknown): string | null {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return 'a knowledge pack is a JSON object';
  const version = (pack as any).schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) return 'schema_version is missing';
  if (version > KNOWLEDGE_PACK_SCHEMA_VERSION) {
    return `schema_version ${version} is newer than this server reads (${KNOWLEDGE_PACK_SCHEMA_VERSION})`;
  }
  if (version < 1) return `schema_version ${version} is not a known version`;
  if (!Array.isArray((pack as any).items)) return 'items must be a list';
  return null;
}

function projectOf(projectId: unknown): string {
  const pid = typeof projectId === 'string' ? projectId.trim() : '';
  if (!pid) throw new BadRequestException('project_id is required');
  return pid;
}

@Injectable()
export class KnowledgePacksService {
  /** Replaced in tests. */
  store: KnowledgePackStore = httpKnowledgePackStore;

  async export(projectId?: string, name?: string): Promise<unknown> {
    return this.store.exportPack(projectOf(projectId), (name || '').trim().slice(0, 120));
  }

  async import(body: { pack?: unknown; project_id?: unknown }): Promise<unknown> {
    const problem = packProblem(body?.pack);
    if (problem) throw new BadRequestException(problem);
    return this.store.importPack(projectOf(body?.project_id), body.pack);
  }
}
