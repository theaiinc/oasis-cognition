import { ProjectController } from './project.controller';

describe('ProjectController operations', () => {
  it('returns project-scoped activity for the operations surface', async () => {
    const events = {
      getActiveSessions: jest.fn().mockResolvedValue([{ session_id: 's1', started_at: 'now' }]),
      getProjectEvents: jest.fn().mockResolvedValue([{ event_type: 'ResponseGenerated', project_id: 'p1' }]),
    };
    const coordinator = {
      listJobs: jest.fn().mockResolvedValue([{ job_id: 'j1', project_id: 'p1', status: 'running' }]),
    };
    const controller = new ProjectController(events as never, coordinator as never);

    await expect(controller.operations(' p1 ', '10')).resolves.toEqual({
      project_id: 'p1',
      active_sessions: [{ session_id: 's1', started_at: 'now' }],
      events: [{ event_type: 'ResponseGenerated', project_id: 'p1' }],
      jobs: [{ job_id: 'j1', project_id: 'p1', status: 'running' }],
    });
    expect(events.getActiveSessions).toHaveBeenCalledWith('p1');
    expect(events.getProjectEvents).toHaveBeenCalledWith('p1', 10);
    expect(coordinator.listJobs).toHaveBeenCalledWith(undefined, 'p1');
  });

  it('requires a project id for operations', async () => {
    const controller = new ProjectController({} as never, {} as never);
    await expect(controller.operations(' ', '10')).rejects.toMatchObject({ status: 400 });
  });
});
