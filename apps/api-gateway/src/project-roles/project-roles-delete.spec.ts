jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    connect: () => Promise.reject(new Error('no redis in tests')),
    on: jest.fn(),
    quit: jest.fn(),
    status: 'end',
  })),
);

import { ProjectRolesService } from './project-roles.service';

const profiles = { ensureDefaultInternal: jest.fn().mockResolvedValue({ profile_id: 'internal' }) };

describe("Deleting a project's roles (#22)", () => {
  it('removes every role of that project and nothing else', async () => {
    const s = new ProjectRolesService(profiles as any);
    await s.create({ project_id: 'p1', kind: 'developer' } as any);
    await s.create({ project_id: 'p1', kind: 'designer' } as any);
    await s.create({ project_id: 'p2', kind: 'developer' } as any);
    expect(await s.deleteByProject('p1')).toBe(2);
    expect(await s.listByProject('p1')).toEqual([]);
    expect(await s.listByProject('p2')).toHaveLength(1);
  });
});
