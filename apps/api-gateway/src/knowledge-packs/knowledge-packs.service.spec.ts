import { BadRequestException } from '@nestjs/common';
import { KnowledgePacksService, packProblem, type KnowledgePackStore } from './knowledge-packs.service';

function service() {
  const calls: Array<{ op: string; projectId: string; pack?: unknown; name?: string }> = [];
  const store: KnowledgePackStore = {
    async exportPack(projectId, name) { calls.push({ op: 'export', projectId, name }); return { schema_version: 1, items: [] }; },
    async importPack(projectId, pack) { calls.push({ op: 'import', projectId, pack }); return { counts: { added: 0, skipped: 0 } }; },
  };
  const svc = new KnowledgePacksService();
  svc.store = store;
  return { svc, calls };
}

const pack = { schema_version: 1, items: [{ type: 'rule', condition: 'c', conclusion: 'd', project_id: 'proj-b' }] };

describe('KnowledgePacksService', () => {
  it('exports a named project, with the name trimmed and capped', async () => {
    const { svc, calls } = service();
    await svc.export(' proj-a ', `  ${'n'.repeat(200)}`);
    expect(calls).toEqual([{ op: 'export', projectId: 'proj-a', name: 'n'.repeat(120) }]);
    await expect(svc.export(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.export('  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('imports into the project the request names, whatever the pack says', async () => {
    const { svc, calls } = service();
    await svc.import({ pack, project_id: 'proj-a' });
    expect(calls).toEqual([{ op: 'import', projectId: 'proj-a', pack }]);
    await expect(svc.import({ pack })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(1);
  });

  it('refuses a pack it cannot read before calling memory-service', async () => {
    const { svc, calls } = service();
    for (const bad of [undefined, [], 'x', { items: [] }, { schema_version: 2, items: [] }, { schema_version: 1 }]) {
      await expect(svc.import({ pack: bad, project_id: 'proj-a' })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(calls).toHaveLength(0);
  });

  it('says what is wrong with a pack', () => {
    expect(packProblem({ schema_version: 1, items: [] })).toBeNull();
    expect(packProblem({ schema_version: 9, items: [] })).toMatch(/newer/);
    expect(packProblem({ schema_version: 0, items: [] })).toMatch(/not a known/);
    expect(packProblem({ schema_version: 1.5, items: [] })).toMatch(/missing/);
  });
});
