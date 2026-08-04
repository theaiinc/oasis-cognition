/**
 * Coordinator HTTP controller — routes under /api/v1/coordinator.
 *
 * Endpoints:
 *   POST /api/v1/coordinator/jobs                              — create job from plan
 *   GET  /api/v1/coordinator/jobs/:id                           — job status + preflight
 *   POST /api/v1/coordinator/jobs/:id/approve                   — user budget + dispatch
 *   POST /api/v1/coordinator/jobs/:id/cancel                    — cancel children
 *   POST /api/v1/coordinator/jobs/:id/child-started             — internal: child container started
 *   POST /api/v1/coordinator/jobs/:id/child-report              — internal: child finished
 *   GET  /api/v1/coordinator/host-capacity                      — cached probe
 *   GET  /api/v1/coordinator/internal/yggdrasil/runners         — proxy: list Yggdrasil runners
 *   GET  /api/v1/coordinator/internal/yggdrasil/runners/:id     — proxy: get runner details
 *   GET  /api/v1/coordinator/internal/yggdrasil/admission       — proxy: admission state
 *   GET  /api/v1/coordinator/internal/yggdrasil/health          — proxy: Yggdrasil controller health
 */

import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CoordinatorService } from './coordinator.service';
import { CoordinatorPreflightService } from './coordinator-preflight.service';
import { HostCapacityService } from './host-capacity.service';
import { YggdrasilBridgeService } from './yggdrasil-bridge.service';
import type { PlannerPlan } from './coordinator.types';

@Controller('coordinator')
export class CoordinatorController {
  private readonly logger = new Logger(CoordinatorController.name);

  constructor(
    private readonly service: CoordinatorService,
    private readonly preflight: CoordinatorPreflightService,
    private readonly hostCapacity: HostCapacityService,
    private readonly yggdrasil: YggdrasilBridgeService,
  ) {}

  @Post('jobs')
  async createJob(
    @Body() body: { plan: PlannerPlan; parent_session_id: string; interaction_id: string; project_id?: string; auto_approve_free?: boolean },
  ) {
    if (!body.plan || !body.parent_session_id) {
      throw new HttpException('plan and parent_session_id are required', HttpStatus.BAD_REQUEST);
    }
    const autoApprove = body.auto_approve_free !== false; // default true
    const result = await this.service.createJob(body.plan, body.parent_session_id, body.interaction_id || '', autoApprove, body.project_id);
    return {
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
    };
  }

  @Get('jobs')
  async listJobs(@Query('parent_session_id') parentSessionId?: string, @Query('project_id') projectId?: string) {
    return this.service.listJobs(parentSessionId, projectId);
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    const job = await this.service.getJob(id);
    if (!job) throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    return job;
  }

  @Post('jobs/:id/approve')
  async approveJob(
    @Param('id') id: string,
    @Body() body: { user_limit?: number } = {},
  ) {
    try {
      const job = await this.service.approveJob(id, body.user_limit);
      return { ok: true, job };
    } catch (err: any) {
      throw new HttpException(err.message, HttpStatus.CONFLICT);
    }
  }

  @Post('jobs/:id/cancel')
  async cancelJob(@Param('id') id: string) {
    try {
      const job = await this.service.cancelJob(id);
      return { ok: true, job };
    } catch (err: any) {
      throw new HttpException(err.message, HttpStatus.CONFLICT);
    }
  }

  @Get('host-capacity')
  async getHostCapacity() {
    const cap = await this.hostCapacity.getCapacity();
    return { ok: true, ...cap };
  }

/** child started — internal: runner task started */
  @Post('jobs/:id/child-started')
  async childStarted(
    @Param('id') id: string,
    @Body() body: { task_id: string; child_session_id?: string },
  ) {
    if (!body.task_id) throw new HttpException('task_id is required', HttpStatus.BAD_REQUEST);
    try {
      await this.service.onChildStarted(id, body.task_id, body.child_session_id);
      return { ok: true };
    } catch (err: any) {
      throw new HttpException(err.message, HttpStatus.NOT_FOUND);
    }
  }

  @Post('jobs/:id/child-report')
  async childReport(
    @Param('id') id: string,
    @Body() body: { task_id: string; status: string; model?: string; tokens?: { input: number; output: number }; final_message?: string },
  ) {
    if (!body.task_id || !body.status) {
      throw new HttpException('task_id and status are required', HttpStatus.BAD_REQUEST);
    }
    try {
      await this.service.onChildReport(id, body.task_id, {
        status: body.status,
        model: body.model,
        tokens: body.tokens,
        final_message: body.final_message,
      });
      return { ok: true };
    } catch (err: any) {
      throw new HttpException(err.message, HttpStatus.NOT_FOUND);
    }
  }

  // ── Yggdrasil proxy endpoints ──────────────────────────────────────

  /** Proxy: list all runners registered with the Yggdrasil controller. */
  @Get('internal/yggdrasil/runners')
  async listRunners() {
    const runners = await this.yggdrasil.listRunners();
    return { ok: true, runners, count: runners.length };
  }

  /** Proxy: get runner details from the Yggdrasil controller. */
  @Get('internal/yggdrasil/runners/:runnerId')
  async getRunner(@Param('runnerId') runnerId: string) {
    const runner = await this.yggdrasil.getRunner(runnerId);
    if (!runner) throw new HttpException('Runner not found', HttpStatus.NOT_FOUND);
    return { ok: true, runner };
  }

  /** Proxy: get admission state from Yggdrasil runner health. */
  @Get('internal/yggdrasil/admission')
  async getAdmission() {
    const state = await this.yggdrasil.getAdmissionState();
    return { ok: true, ...state };
  }

  /** Proxy: health check the Yggdrasil controller itself. */
  @Get('internal/yggdrasil/health')
  async yggdrasilHealth() {
    const health = await this.yggdrasil.health();
    if (!health) throw new HttpException('Yggdrasil unreachable', HttpStatus.SERVICE_UNAVAILABLE);
    return { ok: true, health };
  }
}
