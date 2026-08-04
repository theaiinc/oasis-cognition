import { getHealthEndpoints, waitForService } from './setup';

describe('integration setup', () => {
  it('uses the canonical local service ports by default', () => {
    expect(getHealthEndpoints()).toEqual([
      { name: 'api-gateway', url: 'http://localhost:8000/api/v1/health' },
      { name: 'memory-service', url: 'http://localhost:8004/health' },
      { name: 'response-generator', url: 'http://localhost:8005/health' },
    ]);
  });

  it('fails with a provisioning command when a service is unavailable', async () => {
    await expect(waitForService({
      name: 'unavailable',
      url: 'http://127.0.0.1:1/health',
    })).rejects.toThrow('docker compose -f docker-compose.yml');
  });
});
