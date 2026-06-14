import { Router, Request, Response } from 'express';
import { ExternalAgentsService } from '../external-agents/service';
import { getAdapter } from '../external-agents/adapters';

export function createExternalAgentsRouter(service: ExternalAgentsService): Router {
  const router = Router();

  // POST /api/v1/agents/sessions — create a session
  router.post('/sessions', async (req: Request, res: Response) => {
    try {
      const session = await service.createSession(req.body);
      res.json(session);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/v1/agents/sessions — list sessions
  router.get('/sessions', async (_req: Request, res: Response) => {
    const sessions = service.list();
    res.json(sessions);
  });

  // GET /api/v1/agents/sessions/:id — get session details
  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const session = service.get(req.params.id);
      res.json(session);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // GET /api/v1/agents/sessions/:id/transcript — get parsed transcript
  router.get('/sessions/:id/transcript', async (req: Request, res: Response) => {
    try {
      const events = await service.getTranscript(req.params.id);
      res.json(events);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // GET /api/v1/agents/sessions/:id/diff — get worktree diff
  router.get('/sessions/:id/diff', async (req: Request, res: Response) => {
    try {
      const diff = await service.getDiff(req.params.id);
      res.json({ diff });
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/v1/agents/sessions/:id/message — follow-up message
  router.post('/sessions/:id/message', async (req: Request, res: Response) => {
    try {
      const session = await service.followUp(req.params.id, req.body);
      res.json(session);
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // POST /api/v1/agents/sessions/:id/merge — apply worktree changes
  router.post('/sessions/:id/merge', async (req: Request, res: Response) => {
    try {
      const session = await service.merge(req.params.id, req.body?.commit_message);
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/agents/sessions/:id/discard — discard worktree
  router.post('/sessions/:id/discard', async (req: Request, res: Response) => {
    try {
      const session = await service.discard(req.params.id);
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/agents/sessions/:id/cancel — cancel running session
  router.post('/sessions/:id/cancel', async (req: Request, res: Response) => {
    try {
      const session = await service.cancel(req.params.id);
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/v1/agents/sessions/:id — remove session entirely
  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const result = await service.remove(req.params.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/agents/sessions/:id/stream — SSE event stream
  router.get('/sessions/:id/stream', async (req: Request, res: Response) => {
    try {
      service.get(req.params.id); // validate exists
    } catch (err: any) {
      res.status(404).json({ error: err.message });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { res.end(); } catch { /* noop */ }
    };
    res.on('close', close);

    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);

    try {
      for await (const evt of service.tailEvents(req.params.id)) {
        if (closed) break;
        res.write(`event: event\ndata: ${JSON.stringify(evt)}\n\n`);
      }
      try {
        const session = service.get(req.params.id);
        res.write(`event: status\ndata: ${JSON.stringify({ status: session.status, exit_code: session.exit_code })}\n\n`);
      } catch { /* session may have been removed */ }
    } catch (err: any) {
      console.warn(`stream error for ${req.params.id}: ${err.message}`);
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      close();
    }
  });

  return router;
}
