/**
 * Workflows HTTP controller — mounted at /api/v1/workflows.
 *
 * Also hosts the trigger CRUD and the per-run SSE stream.
 */

import {
  Body, Controller, Delete, Get, HttpException, HttpStatus, Logger,
  Param, Patch, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { WorkflowsService } from './workflows.service';
import { TriggersService } from './triggers/triggers.service';
import { listRegisteredTypes } from './node-registry';
import type {
  CreateTriggerDto, CreateWorkflowDto, RunWorkflowDto, UpdateWorkflowDto,
} from './workflows.types';

@Controller('workflows')
export class WorkflowsController {
  private readonly logger = new Logger(WorkflowsController.name);

  constructor(
    private readonly workflows: WorkflowsService,
    private readonly triggers: TriggersService,
  ) {}

  /* ── Node catalogue (used by UI palette) ─────────────────────── */

  @Get('node-catalog')
  async nodeCatalog() {
    return { node_types: listRegisteredTypes() };
  }

  /* ── Workflow CRUD ───────────────────────────────────────────── */

  @Post()
  async create(@Body() dto: CreateWorkflowDto) {
    return this.workflows.createWorkflow(dto);
  }

  @Get()
  async list() {
    return this.workflows.listWorkflows();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.workflows.getWorkflow(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() patch: UpdateWorkflowDto) {
    return this.workflows.updateWorkflow(id, patch);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.workflows.deleteWorkflow(id);
    return { deleted: true };
  }

  /* ── Runs ────────────────────────────────────────────────────── */

  @Post(':id/run')
  async runNow(@Param('id') id: string, @Body() dto: RunWorkflowDto = {}) {
    return this.workflows.runNow(id, dto);
  }

  @Get(':id/runs')
  async listRuns(@Param('id') id: string, @Query('limit') limitStr?: string) {
    const limit = Math.max(1, Math.min(200, parseInt(limitStr || '50', 10) || 50));
    return this.workflows.listRuns(id, limit);
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    return this.workflows.getRun(runId);
  }

  @Post('runs/:runId/cancel')
  async cancelRun(@Param('runId') runId: string) {
    return this.workflows.cancelRun(runId);
  }

  /**
   * SSE stream for one run: replays accumulated events then live-tails.
   */
  @Get('runs/:runId/stream')
  async streamRun(
    @Param('runId') runId: string,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    // Validate run exists
    await this.workflows.getRun(runId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => { closed = true; });

    const store = this.workflows.getStore();

    // Replay accumulated events first
    let lastId = '0-0';
    try {
      const replay = await store.replayRunEvents(runId);
      for (const ev of replay) {
        if (closed) return;
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
        lastId = ev.id;
      }
    } catch (err: any) {
      this.logger.debug(`replay failed for ${runId}: ${err.message}`);
    }

    // Heartbeat so proxies don't reap idle connections
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: hb ${Date.now()}\n\n`);
    }, 15_000);

    try {
      // Live-tail. Stop when we see a `status` event in a terminal state.
      while (!closed) {
        const events = await store.readRunEvents(runId, lastId, 5_000);
        for (const ev of events) {
          if (closed) break;
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
          lastId = ev.id;
          if (ev.type === 'status' && isTerminal(ev.payload?.status)) {
            closed = true;
          }
        }
        // Safety: if the run has already reached a terminal state in storage,
        // exit even if no stream entry arrives.
        const snapshot = await store.getRun(runId);
        if (snapshot && isTerminal(snapshot.status)) break;
      }
    } catch (err: any) {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* noop */ }
    }
  }

  /* ── Triggers ────────────────────────────────────────────────── */

  @Get(':id/triggers')
  async listTriggers(@Param('id') id: string) {
    return this.triggers.listTriggers(id);
  }

  @Post(':id/triggers')
  async createTrigger(@Param('id') id: string, @Body() dto: CreateTriggerDto) {
    return this.triggers.createTrigger(id, dto);
  }

  @Patch('triggers/:triggerId')
  async updateTrigger(
    @Param('triggerId') triggerId: string,
    @Body() patch: Partial<CreateTriggerDto>,
  ) {
    return this.triggers.updateTrigger(triggerId, patch);
  }

  @Delete('triggers/:triggerId')
  async deleteTrigger(@Param('triggerId') triggerId: string) {
    await this.triggers.deleteTrigger(triggerId);
    return { deleted: true };
  }
}

function isTerminal(status?: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
