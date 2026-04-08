import { Router, Request, Response } from 'express';
import { RelayService, RelayError } from './relay.service';
import { EncryptedPayload } from '../crypto/crypto.types';

export function createRelayRouter(relayService: RelayService): Router {
  const router = Router();

  /** Mobile sends an encrypted chat message. */
  router.post('/interaction', async (req: Request, res: Response) => {
    try {
      const payload = req.body as EncryptedPayload;
      if (!payload.pid || !payload.iv || !payload.ct || !payload.tag) {
        res.status(400).json({ error: 'Invalid encrypted payload' });
        return;
      }

      const { body: decryptedBody, session } = relayService.decryptRequest(payload);

      // Stream encrypted NDJSON back
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200);
      res.flushHeaders();

      await relayService.streamInteraction(
        decryptedBody,
        payload.pid,
        session!.mobileSessionId,
        (encrypted: EncryptedPayload) => {
          if (!res.writableEnded) {
            res.write(JSON.stringify(encrypted) + '\n');
          }
        },
        () => {
          if (!res.writableEnded) {
            res.end();
          }
        },
      );
    } catch (err: any) {
      handleRelayError(err, res);
    }
  });

  /** Mobile fetches encrypted session list. */
  router.get('/history/sessions', async (req: Request, res: Response) => {
    try {
      const pid = req.headers['x-pairing-id'] as string;
      if (!pid) {
        res.status(400).json({ error: 'Missing x-pairing-id header' });
        return;
      }
      const encrypted = await relayService.proxyHistory('sessions', req.query as Record<string, string>, pid);
      res.json(encrypted);
    } catch (err: any) {
      handleRelayError(err, res);
    }
  });

  /** Mobile fetches encrypted message history. */
  router.get('/history/messages', async (req: Request, res: Response) => {
    try {
      const pid = req.headers['x-pairing-id'] as string;
      if (!pid) {
        res.status(400).json({ error: 'Missing x-pairing-id header' });
        return;
      }
      const encrypted = await relayService.proxyHistory('messages', req.query as Record<string, string>, pid);
      res.json(encrypted);
    } catch (err: any) {
      handleRelayError(err, res);
    }
  });

  /** Mobile fetches project config (unencrypted — no secrets). */
  router.get('/project/config', async (_req: Request, res: Response) => {
    try {
      const config = await relayService.proxyProjectConfig();
      res.json(config);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch project config' });
    }
  });

  /** List chat sessions (unencrypted — session metadata isn't sensitive). */
  router.get('/sessions', async (_req: Request, res: Response) => {
    try {
      const data = await relayService.listSessions();
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch sessions' });
    }
  });

  /** Load messages for a session. */
  router.get('/sessions/:sessionId/messages', async (req: Request, res: Response) => {
    try {
      const data = await relayService.loadSessionMessages(req.params.sessionId as string);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch messages' });
    }
  });

  /** List available projects. */
  router.get('/projects', async (_req: Request, res: Response) => {
    try {
      const data = await relayService.listProjects();
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch projects' });
    }
  });

  /** List artifacts. */
  router.get('/artifacts', async (_req: Request, res: Response) => {
    try {
      const data = await relayService.listArtifacts();
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch artifacts' });
    }
  });

  /** Switch active project. */
  router.post('/projects/activate', async (req: Request, res: Response) => {
    try {
      const { project_id } = req.body;
      if (!project_id) {
        res.status(400).json({ error: 'project_id is required' });
        return;
      }
      const data = await relayService.activateProject(project_id);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to activate project' });
    }
  });

  /** Start a screen share session from mobile (creates a computer-use session). */
  router.post('/screen-share/start', async (req: Request, res: Response) => {
    try {
      const { goal, screen_image } = req.body;
      if (!goal?.trim()) {
        res.status(400).json({ error: 'goal is required' });
        return;
      }
      const data = await relayService.startScreenShareSession(goal, screen_image);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to start screen share session', detail: err.message });
    }
  });

  /** Push a screen frame from mobile to an active computer-use session. */
  router.post('/screen-share/frame', async (req: Request, res: Response) => {
    try {
      const { session_id, image } = req.body;
      if (!session_id || !image) {
        res.status(400).json({ error: 'session_id and image are required' });
        return;
      }
      const data = await relayService.pushScreenFrame(session_id, image);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to push screen frame' });
    }
  });

  /** Stop a screen share session from mobile. */
  router.post('/screen-share/stop', async (req: Request, res: Response) => {
    try {
      const { session_id } = req.body;
      if (!session_id) {
        res.status(400).json({ error: 'session_id is required' });
        return;
      }
      const data = await relayService.stopScreenShareSession(session_id);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to stop screen share session' });
    }
  });

  /** Get active computer-use session status (including live screenshot). */
  router.get('/computer-use/session', async (req: Request, res: Response) => {
    try {
      const sessionId = req.query.session_id as string | undefined;
      const result = await relayService.getComputerUseSession(sessionId);
      res.json(result);
    } catch (err: any) {
      res.status(err.response?.status || 502).json({
        error: 'Failed to get computer-use session',
        detail: err.message,
      });
    }
  });

  /** Approve a computer-use session plan from mobile. */
  router.post('/computer-use/approve', async (req: Request, res: Response) => {
    try {
      const { session_id } = req.body;
      if (!session_id) {
        res.status(400).json({ error: 'session_id is required' });
        return;
      }
      const result = await relayService.approveComputerUseSession(session_id);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to approve session' });
    }
  });

  /** Cancel a computer-use session from mobile. */
  router.post('/computer-use/cancel', async (req: Request, res: Response) => {
    try {
      const { session_id } = req.body;
      if (!session_id) {
        res.status(400).json({ error: 'session_id is required' });
        return;
      }
      const result = await relayService.cancelComputerUseSession(session_id);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to cancel session' });
    }
  });

  /** Pause (emergency stop) a running computer-use session. */
  router.post('/computer-use/pause', async (req: Request, res: Response) => {
    try {
      const { session_id } = req.body;
      if (!session_id) { res.status(400).json({ error: 'session_id is required' }); return; }
      const result = await relayService.pauseComputerUseSession(session_id);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to pause session' });
    }
  });

  /** Resume a paused computer-use session. */
  router.post('/computer-use/resume', async (req: Request, res: Response) => {
    try {
      const { session_id } = req.body;
      if (!session_id) { res.status(400).json({ error: 'session_id is required' }); return; }
      const result = await relayService.resumeComputerUseSession(session_id);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to resume session' });
    }
  });

  /** Send steering feedback to an executing computer-use session. */
  router.post('/computer-use/feedback', async (req: Request, res: Response) => {
    try {
      const { session_id, message } = req.body;
      if (!session_id || !message) { res.status(400).json({ error: 'session_id and message are required' }); return; }
      const result = await relayService.sendComputerUseFeedback(session_id, message);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to send feedback' });
    }
  });

  /** Take a native screenshot from desktop (dev-agent pyautogui). */
  router.post('/screenshot', async (req: Request, res: Response) => {
    try {
      const result = await relayService.takeScreenshot(req.body?.target);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to take screenshot' });
    }
  });

  /** Mobile requests a desktop tool action (screenshot, computer use). */
  router.post('/tool-request', async (req: Request, res: Response) => {
    try {
      const payload = req.body as EncryptedPayload;
      if (!payload.pid || !payload.iv || !payload.ct || !payload.tag) {
        res.status(400).json({ error: 'Invalid encrypted payload' });
        return;
      }

      const { body: toolRequest } = relayService.decryptRequest(payload);
      if (!toolRequest.type) {
        res.status(400).json({ error: 'Tool request must include a type field' });
        return;
      }

      const encrypted = await relayService.executeToolRequest(toolRequest, payload.pid);
      res.json(encrypted);
    } catch (err: any) {
      handleRelayError(err, res);
    }
  });

  return router;
}

function handleRelayError(err: any, res: Response): void {
  if (err instanceof RelayError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
  } else {
    console.error('[Relay] Unhandled error:', err.message);
    res.status(500).json({ error: 'relay_error', message: err.message || 'Internal relay error' });
  }
}
