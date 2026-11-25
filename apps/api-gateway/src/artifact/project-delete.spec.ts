import axios from 'axios';
import { ProjectsController } from './artifact.controller';
import { ProjectRolesService } from '../project-roles/project-roles.service';
import { MissionsService } from '../missions/missions.service';
import { WorkflowsService } from '../workflows/workflows.service';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

describe('DELETE /projects/:id (#22)', () => {
  const roles = { deleteByProject: jest.fn().mockResolvedValue(3) };
  const missions = { list: jest.fn().mockResolvedValue([{ mission_id: 'm1', project_id: 'p1' }]), remove: jest.fn() };
  const workflows = { listWorkflows: jest.fn().mockResolvedValue([]), deleteWorkflow: jest.fn() };
  const moduleRef = {
    get: jest.fn((cls: unknown) => {
      if (cls === ProjectRolesService) return roles;
      if (cls === MissionsService) return missions;
      if (cls === WorkflowsService) return workflows;
      throw new Error('unknown');
    }),
  };
  const controller = () => new ProjectsController(moduleRef as never);

  beforeEach(() => jest.clearAllMocks());

  it('deletes the project, then cleans up after it and says what it removed', async () => {
    mocked.get.mockImplementation(async (url: string) => {
      if (url.includes('/internal/memory/projects/p1')) return { data: { project_id: 'p1', project_path: '/workspace/u/p1' } };
      if (url.includes('/agents/sessions')) return { data: [{ session_id: 's1', project_path: '/workspace/u/p1' }] };
      throw new Error(`unexpected GET ${url}`);
    });
    mocked.delete.mockResolvedValue({ data: { status: 'ok', deleted: true } });

    const res = await controller().delete('p1');

    expect(res).toEqual({ status: 'ok', deleted: true, cleaned: { roles: 3, missions: 1, workflows: 0, agent_sessions: 1, errors: [] } });
    expect(missions.remove).toHaveBeenCalledWith('m1');
    expect(mocked.delete).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/agents\/sessions\/s1$/), expect.anything());
  });

  it('answers 404 for a project that does not exist, and cleans nothing', async () => {
    mocked.get.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    await expect(controller().delete('nope')).rejects.toMatchObject({ status: 404 });
    expect(mocked.delete).not.toHaveBeenCalled();
    expect(roles.deleteByProject).not.toHaveBeenCalled();
  });

  it('answers 404 when the memory service had nothing to delete', async () => {
    mocked.get.mockResolvedValue({ data: { project_id: 'p1' } });
    mocked.delete.mockResolvedValue({ data: { status: 'ok', deleted: false } });
    await expect(controller().delete('p1')).rejects.toMatchObject({ status: 404 });
    expect(roles.deleteByProject).not.toHaveBeenCalled();
  });
});
