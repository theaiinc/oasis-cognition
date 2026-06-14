/**
 * Dev-agent proxy — forwards /internal/dev-agent/* calls to the actual dev-agent.
 *
 * The api-gateway routes dev-agent calls through oasis-agent so that:
 *   - oasis-agent is the single control-plane entry for all agent concerns
 *   - The api-gateway doesn't need host.docker.internal access to the dev-agent
 *   - Future routing logic (e.g. dev-agent → yggdrasil fallback) lives here
 */

import { Router, type Request, type Response } from 'express';
import axios from 'axios';

export function createDevAgentProxyRouter(devAgentUrl: string): Router {
  const router = Router();
  const DEV_AGENT_URL = devAgentUrl;

  // POST proxy — the most common verb for dev-agent execute / overlay / file ops
  router.post('/dev-agent/*', async (req: Request, res: Response) => {
    const subPath = req.path.replace(/^\/dev-agent\//, '');
    const targetUrl = `${DEV_AGENT_URL}/internal/dev-agent/${subPath}`;

    try {
      const upstream = await axios({
        method: 'post',
        url: targetUrl,
        data: req.body,
        headers: { 'Content-Type': 'application/json' },
        timeout: 120_000,
        validateStatus: () => true,
      });
      res.status(upstream.status).json(upstream.data);
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        res.status(502).json({ error: 'dev-agent unreachable', details: err.message });
      } else {
        res.status(500).json({ error: 'dev-agent proxy error', details: err.message });
      }
    }
  });

  // GET proxy — for cu-interference, file read, etc.
  router.get('/dev-agent/*', async (req: Request, res: Response) => {
    const subPath = req.path.replace(/^\/dev-agent\//, '');
    const targetUrl = `${DEV_AGENT_URL}/internal/dev-agent/${subPath}`;

    try {
      const upstream = await axios({
        method: 'get',
        url: targetUrl,
        params: req.query,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
        validateStatus: () => true,
      });
      res.status(upstream.status).json(upstream.data);
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        res.status(502).json({ error: 'dev-agent unreachable', details: err.message });
      } else {
        res.status(500).json({ error: 'dev-agent proxy error', details: err.message });
      }
    }
  });

  // DELETE proxy — for worktree discard
  router.delete('/dev-agent/*', async (req: Request, res: Response) => {
    const subPath = req.path.replace(/^\/dev-agent\//, '');
    const targetUrl = `${DEV_AGENT_URL}/internal/dev-agent/${subPath}`;

    try {
      const upstream = await axios({
        method: 'delete',
        url: targetUrl,
        data: req.body,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
        validateStatus: () => true,
      });
      res.status(upstream.status).json(upstream.data);
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        res.status(502).json({ error: 'dev-agent unreachable', details: err.message });
      } else {
        res.status(500).json({ error: 'dev-agent proxy error', details: err.message });
      }
    }
  });

  return router;
}
