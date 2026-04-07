import { Router, Request, Response } from 'express';
import { PairingService } from './pairing.service';
import {
  InitiatePairingRequest,
  CompletePairingRequest,
  ScreenAccessRequest,
} from './pairing.types';

export function createPairingRouter(pairingService: PairingService): Router {
  const router = Router();

  /** Desktop initiates pairing — generates QR payload. */
  router.post('/initiate', async (req: Request, res: Response) => {
    try {
      const body = req.body as InitiatePairingRequest;
      const result = await pairingService.initiate(body);
      res.json(result);
    } catch (err: any) {
      console.error('[Pairing] Initiate failed:', err.message);
      res.status(503).json({ error: err.message });
    }
  });

  /** Mobile completes pairing — sends its half-key. */
  router.post('/complete', (req: Request, res: Response) => {
    try {
      const body = req.body as CompletePairingRequest;
      if (!body.pairing_id || !body.mobile_half_key) {
        res.status(400).json({ error: 'Missing pairing_id or mobile_half_key' });
        return;
      }
      const result = pairingService.complete(body.pairing_id, body.mobile_half_key);
      res.json(result);
    } catch (err: any) {
      const status = err.message.includes('expired') ? 410
        : err.message.includes('already paired') ? 409
        : err.message.includes('mismatch') ? 400
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  /** Desktop revokes active pairing. */
  router.delete('/', (_req: Request, res: Response) => {
    try {
      pairingService.revoke();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Check pairing status (desktop polls this). */
  router.get('/status', (_req: Request, res: Response) => {
    res.json(pairingService.getStatus());
  });

  /** Desktop toggles screen sharing access for mobile. */
  router.post('/screen-access', (req: Request, res: Response) => {
    try {
      const body = req.body as ScreenAccessRequest;
      if (typeof body.grant !== 'boolean') {
        res.status(400).json({ error: 'grant must be a boolean' });
        return;
      }
      pairingService.setScreenAccess(body.grant);
      res.json({ screen_share_granted: body.grant });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
