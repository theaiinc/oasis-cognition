import axios from 'axios';
import { JanusService } from './janus.service';

describe('JanusService', () => {
  const originalBaseUrl = process.env.JANUS_BASE_URL;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBaseUrl === undefined) delete process.env.JANUS_BASE_URL;
    else process.env.JANUS_BASE_URL = originalBaseUrl;
  });

  it('is safely disabled when no Janus URL is configured', async () => {
    delete process.env.JANUS_BASE_URL;

    await expect(new JanusService().health()).resolves.toEqual({
      configured: false,
      available: false,
      status: 'disabled',
    });
  });

  it('maps Janus status without exposing the response payload', async () => {
    process.env.JANUS_BASE_URL = 'http://janus.test/';
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { status: 'degraded', secret: 'redacted' } } as any);

    await expect(new JanusService().health()).resolves.toEqual({
      configured: true,
      available: true,
      status: 'degraded',
    });
    expect(axios.get).toHaveBeenCalledWith('http://janus.test/api/status', expect.any(Object));
  });

  it('reports Janus outages without failing the gateway health boundary', async () => {
    process.env.JANUS_BASE_URL = 'http://janus.test';
    jest.spyOn(axios, 'get').mockRejectedValue({ code: 'ECONNREFUSED' });

    await expect(new JanusService().health()).resolves.toEqual({
      configured: true,
      available: false,
      status: 'unavailable',
      error: 'ECONNREFUSED',
    });
  });
});
