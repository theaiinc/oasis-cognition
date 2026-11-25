import { cleanupProject } from './project-cleanup';

describe('cleanupProject (#22)', () => {
  it("removes the project's roles, missions, workflows and agent sessions, and counts them", async () => {
    const removedMissions: string[] = [];
    const removedWorkflows: string[] = [];
    const removedSessions: string[] = [];
    const summary = await cleanupProject('p1', '/workspace/u/proj/', {
      roles: { deleteByProject: jest.fn().mockResolvedValue(7) },
      missions: {
        list: jest.fn().mockResolvedValue([{ mission_id: 'm1', project_id: 'p1' }, { mission_id: 'm2', project_id: 'p2' }]),
        remove: async (id) => { removedMissions.push(id); },
      },
      workflows: {
        listWorkflows: jest.fn().mockResolvedValue([{ workflow_id: 'w1', project_id: 'p1' }, { workflow_id: 'w2' }]),
        deleteWorkflow: async (id) => { removedWorkflows.push(id); },
      },
      agentSessions: {
        list: jest.fn().mockResolvedValue([
          { session_id: 's1', project_path: '/workspace/u/proj' },
          { session_id: 's2', project_path: '/workspace/u/other' },
        ]),
        remove: async (id) => { removedSessions.push(id); },
      },
    });
    expect(summary).toEqual({ roles: 7, missions: 1, workflows: 1, agent_sessions: 1, errors: [] });
    expect(removedMissions).toEqual(['m1']);
    expect(removedWorkflows).toEqual(['w1']);
    expect(removedSessions).toEqual(['s1']);
  });

  it('keeps going when one part fails, and reports it', async () => {
    const summary = await cleanupProject('p1', undefined, {
      roles: { deleteByProject: jest.fn().mockRejectedValue(new Error('redis down')) },
      missions: { list: jest.fn().mockResolvedValue([{ mission_id: 'm1', project_id: 'p1' }]), remove: jest.fn().mockResolvedValue(undefined) },
      workflows: null,
      agentSessions: { list: jest.fn(), remove: jest.fn() },
    });
    expect(summary.missions).toBe(1);
    expect(summary.errors).toEqual(['roles: redis down']);
    expect(summary.agent_sessions).toBe(0);
  });
});
