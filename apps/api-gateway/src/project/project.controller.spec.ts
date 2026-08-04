import axios from 'axios';
import { ProjectController } from './project.controller';

describe('ProjectController operations', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns project-scoped activity for the operations surface', async () => {
    const events = {
      getActiveSessions: jest.fn().mockResolvedValue([{ session_id: 's1', started_at: 'now' }]),
      getProjectEvents: jest.fn().mockResolvedValue([{ event_type: 'ResponseGenerated', project_id: 'p1' }]),
    };
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: [{ job_id: 'j1', project_id: 'p1', status: 'running' }],
    } as never);
    const controller = new ProjectController(events as never);

    await expect(controller.operations(' p1 ', '10')).resolves.toEqual({
      project_id: 'p1',
      active_sessions: [{ session_id: 's1', started_at: 'now' }],
      events: [{ event_type: 'ResponseGenerated', project_id: 'p1' }],
      jobs: [{ job_id: 'j1', project_id: 'p1', status: 'running' }],
    });
    expect(events.getActiveSessions).toHaveBeenCalledWith('p1');
    expect(events.getProjectEvents).toHaveBeenCalledWith('p1', 10);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/coordinator/jobs'),
      expect.objectContaining({ params: { project_id: 'p1' } }),
    );
  });

  it('omits jobs when oasis-agent is unavailable', async () => {
    const events = {
      getActiveSessions: jest.fn().mockResolvedValue([]),
      getProjectEvents: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
    const controller = new ProjectController(events as never);

    await expect(controller.operations('p1', '10')).resolves.toMatchObject({ jobs: [] });
  });

  it('requires a project id for operations', async () => {
    const controller = new ProjectController({} as never);
    await expect(controller.operations(' ', '10')).rejects.toMatchObject({ status: 400 });
  });
});
