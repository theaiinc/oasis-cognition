/**
 * Oasis Agent — standalone coordinator, external agents, and dev-agent proxy.
 *
 * This is the control-plane service. Runner processes (yggdrasil pool, registry)
 * are standalone daemons started independently — they live in src/runner/ only
 * to share the same node_modules at build time.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

import { CoordinatorService, CoordinatorPreflightService, HostCapacityService, YggdrasilBridgeService, JobUsageService, JobBudgetService, RedisEventService } from './coordinator';
import { ExternalAgentsService } from './external-agents';
import { createCoordinatorRouter } from './routes/coordinator';
import { createExternalAgentsRouter } from './routes/external-agents';
import { createDevAgentProxyRouter } from './routes/dev-agent-proxy';

const PORT = parseInt(process.env.OASIS_AGENT_PORT || '8020', 10);

function bootstrap(): void {
  // ── Services ──────────────────────────────────────────────────────

  const redisEvents = new RedisEventService();
  const yggdrasil = new YggdrasilBridgeService();
  const hostCapacity = new HostCapacityService();
  const jobUsage = new JobUsageService();
  const jobBudget = new JobBudgetService();
  const preflight = new CoordinatorPreflightService(
    hostCapacity,
    yggdrasil,
    jobUsage,
    jobBudget,
  );
  const coordinator = new CoordinatorService(
    preflight,
    hostCapacity,
    yggdrasil,
    jobUsage,
    jobBudget,
    redisEvents,
  );
  const externalAgents = new ExternalAgentsService();
  const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';

  // ── Express app ───────────────────────────────────────────────────

  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'oasis-agent', timestamp: new Date().toISOString() });
  });

  // Coordinator routes under /api/v1/coordinator
  app.use('/api/v1/coordinator', createCoordinatorRouter(
    coordinator,
    preflight,
    hostCapacity,
    yggdrasil,
  ));

  // External agents routes under /api/v1/agents
  app.use('/api/v1/agents', createExternalAgentsRouter(externalAgents));

  // Dev-agent proxy routes under /api/v1/internal
  app.use('/api/v1/internal', createDevAgentProxyRouter(DEV_AGENT_URL));

  app.listen(PORT, () => {
    console.log(`oasis-agent listening on http://0.0.0.0:${PORT}`);
    console.log(`  Coordinator:  http://0.0.0.0:${PORT}/api/v1/coordinator/jobs`);
    console.log(`  Agents:       http://0.0.0.0:${PORT}/api/v1/agents/sessions`);
    console.log(`  Dev-agent:    http://0.0.0.0:${PORT}/api/v1/internal/dev-agent/execute`);
    console.log(`  Yggdrasil:    ${process.env.YGGDRASIL_URL || 'http://yggdrasil:3100'}`);
    console.log(`  Dev-agent:    ${DEV_AGENT_URL}`);
  });
}

bootstrap();
