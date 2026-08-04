import { ProjectContextService } from './project-context.service';

describe('ProjectContextService', () => {
  it('keeps nested asynchronous operations scoped to their project', async () => {
    const service = new ProjectContextService();

    await Promise.all([
      service.run({ project_id: 'project-a', session_id: 'session-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(service.get()).toMatchObject({ project_id: 'project-a', session_id: 'session-a' });
      }),
      service.run({ project_id: 'project-b', session_id: 'session-b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(service.get()).toMatchObject({ project_id: 'project-b', session_id: 'session-b' });
      }),
    ]);

    expect(service.get()).toBeUndefined();
  });
});
