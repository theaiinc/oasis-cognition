import axios from 'axios';
import { CoordinatorController } from './coordinator.controller';

describe('CoordinatorController', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards approval requests to oasis-agent', async () => {
    const request = jest.spyOn(axios, 'request').mockResolvedValue({
      data: { ok: true, job: { job_id: 'job/1', status: 'running' } },
    } as any);
    const controller = new CoordinatorController();

    await expect(controller.approve('job/1', { user_limit: 2 })).resolves.toEqual({
      ok: true,
      job: { job_id: 'job/1', status: 'running' },
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'post',
      url: expect.stringContaining('/api/v1/coordinator/jobs/job%2F1/approve'),
      data: { user_limit: 2 },
    }));
  });

  it('maps coordinator outages to a service-unavailable response', async () => {
    jest.spyOn(axios, 'request').mockRejectedValue({ code: 'ECONNREFUSED' });
    const controller = new CoordinatorController();

    await expect(controller.cancel('job-1')).rejects.toMatchObject({ status: 503 });
  });
});
