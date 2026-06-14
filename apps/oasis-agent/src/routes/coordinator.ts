import { Router, Request, Response } from 'express';
import { CoordinatorService } from '../coordinator/service';
import { CoordinatorPreflightService } from '../coordinator/preflight';
import { HostCapacityService } from '../coordinator/host-capacity';
import { YggdrasilBridgeService } from '../coordinator/yggdrasil-bridge';

export function createCoordinatorRouter(
  service: CoordinatorService,
  preflight: CoordinatorPreflightService,
  hostCapacity: HostCapacityService,
  yggdrasil: YggdrasilBridgeService,
): Router {
  const router = Router();

  // POST /api/v1/coordinator/jobs — create job from plan
  router.post('/jobs', async (req: Request, res: Response) => {
    try {
      const { plan, parent_session_id, interaction_id, auto_approve_free } = req.body;
      if (!plan || !parent_session_id) {
        res.status(400).json({ error: 'plan and parent_session_id are required' });
        return;
      }
      const autoApprove = auto_approve_free !== false;
      const result = await service.createJob(plan, parent_session_id, interaction_id || '', autoApprove);
      res.json({
        ok: true,
        job_id: result.job.job_id,
        job: result.job,
        budget: result.budget,
        parallel_allowed: result.parallel_allowed,
        degraded_mode: result.degraded_mode,
        degraded_reason: result.degraded_reason,
        approval_required: result.approval_required,
        est_usd_low: result.job.est_usd_low,
        est_usd_high: result.job.est_usd_high,
        host_capacity: result.host_capacity,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/coordinator/jobs — list jobs
  router.get('/jobs', async (req: Request, res: Response) => {
    const parentSessionId = req.query.parent_session_id as string | undefined;
    const jobs = await service.listJobs(parentSessionId);
    res.json(jobs);
  });

  // GET /api/v1/coordinator/jobs/:id — get job
  router.get('/jobs/:id', async (req: Request, res: Response) => {
    const job = await service.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  // POST /api/v1/coordinator/jobs/:id/approve — approve and dispatch
  router.post('/jobs/:id/approve', async (req: Request, res: Response) => {
    try {
      const job = await service.approveJob(req.params.id, req.body.user_limit);
      res.json({ ok: true, job });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // POST /api/v1/coordinator/jobs/:id/cancel — cancel job
  router.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
    try {
      const job = await service.cancelJob(req.params.id);
      res.json({ ok: true, job });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // GET /api/v1/coordinator/host-capacity
  router.get('/host-capacity', async (_req: Request, res: Response) => {
    const cap = await hostCapacity.getCapacity();
    res.json({ ok: true, ...cap });
  });

  // POST /api/v1/coordinator/jobs/:id/child-started
  router.post('/jobs/:id/child-started', async (req: Request, res: Response) => {
    const { task_id, child_session_id } = req.body;
    if (!task_id) {
      res.status(400).json({ error: 'task_id is required' });
      return;
    }
    try {
      await service.onChildStarted(req.params.id, task_id, child_session_id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // POST /api/v1/coordinator/jobs/:id/child-report
  router.post('/jobs/:id/child-report', async (req: Request, res: Response) => {
    const { task_id, status, model, tokens, final_message } = req.body;
    if (!task_id || !status) {
      res.status(400).json({ error: 'task_id and status are required' });
      return;
    }
    try {
      await service.onChildReport(req.params.id, task_id, {
        status,
        model,
        tokens,
        final_message,
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Yggdrasil proxy endpoints ──────────────────────────────────────

  router.get('/internal/yggdrasil/runners', async (_req: Request, res: Response) => {
    const runners = await yggdrasil.listRunners();
    res.json({ ok: true, runners, count: runners.length });
  });

  router.get('/internal/yggdrasil/runners/:runnerId', async (req: Request, res: Response) => {
    const runner = await yggdrasil.getRunner(req.params.runnerId);
    if (!runner) {
      res.status(404).json({ error: 'Runner not found' });
      return;
    }
    res.json({ ok: true, runner });
  });

  router.get('/internal/yggdrasil/admission', async (_req: Request, res: Response) => {
    const state = await yggdrasil.getAdmissionState();
    res.json({ ok: true, ...state });
  });

  router.get('/internal/yggdrasil/health', async (_req: Request, res: Response) => {
    const health = await yggdrasil.health();
    if (!health) {
      res.status(503).json({ error: 'Yggdrasil unreachable' });
      return;
    }
    res.json({ ok: true, health });
  });

  return router;
}
