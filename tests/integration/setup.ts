/**
 * Global setup for integration tests.
 * - Ensures all services are reachable via health checks
 * - Registers the suite teardown
 */
import * as http from 'http';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8000';
const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';
const RESPONSE_URL = process.env.RESPONSE_URL || 'http://localhost:8005';
const POLL_INTERVAL_MS = Number(process.env.INTEGRATION_POLL_INTERVAL_MS || 500);
const MAX_WAIT_MS = Number(process.env.INTEGRATION_SETUP_TIMEOUT_MS || 10_000);

interface HealthEndpoint {
  name: string;
  url: string;
}

export function getHealthEndpoints(): HealthEndpoint[] {
  return [
  { name: 'api-gateway', url: `${GATEWAY_URL}/api/v1/health` },
  { name: 'memory-service', url: `${MEMORY_URL}/health` },
  { name: 'response-generator', url: `${RESPONSE_URL}/health` },
  ];
}

function httpGet(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      resolve({ status: res.statusCode || 0 });
      res.resume();
    }).on('error', reject);
  });
}

export async function waitForService(endpoint: HealthEndpoint): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(endpoint.url);
      if (res.status >= 200 && res.status < 500) {
        console.log(`  [setup] ${endpoint.name} is ready (${res.status})`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Service ${endpoint.name} did not become ready within ${MAX_WAIT_MS}ms. ` +
    'Start the stack with: docker compose -f docker-compose.yml ' +
    '-f tests/integration/docker-compose.test.yml up -d',
  );
}

export default async function setup(): Promise<void> {
  console.log('[setup] Waiting for services...');
  await Promise.all(getHealthEndpoints().map(waitForService));
  console.log('[setup] All services are ready.');
}
