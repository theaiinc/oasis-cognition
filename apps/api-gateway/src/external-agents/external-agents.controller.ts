/**
 * External-agents HTTP controller — routes under /api/v1/agents.
 *
 * Mirrors the `computer-use` module conventions: one session id per run, a
 * clear lifecycle (creating → running → awaiting_merge → merged/discarded),
 * and an SSE stream endpoint for the transcript.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ExternalAgentsService } from './external-agents.service';
import type { AgentFollowUpDto, CreateAgentSessionDto } from './external-agents.types';

@Controller('agents')
export class ExternalAgentsController {
  private readonly logger = new Logger(ExternalAgentsController.name);

  constructor(private readonly service: ExternalAgentsService) {}

  @Post('sessions')
  async create(@Body() dto: CreateAgentSessionDto) {
    return this.service.createSession(dto);
  }

  @Get('sessions')
  async list() {
    return this.service.list();
  }

  @Get('sessions/:id')
  async get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get('sessions/:id/transcript')
  async transcript(@Param('id') id: string) {
    return this.service.getTranscript(id);
  }

  @Get('sessions/:id/diff')
  async diff(@Param('id') id: string) {
    const diff = await this.service.getDiff(id);
    return { diff };
  }

  @Post('sessions/:id/message')
  async message(@Param('id') id: string, @Body() dto: AgentFollowUpDto) {
    return this.service.followUp(id, dto);
  }

  @Post('sessions/:id/merge')
  async merge(
    @Param('id') id: string,
    @Body() body: { commit_message?: string } = {},
  ) {
    return this.service.merge(id, body?.commit_message);
  }

  @Post('sessions/:id/discard')
  async discard(@Param('id') id: string) {
    return this.service.discard(id);
  }

  @Post('sessions/:id/cancel')
  async cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }

  @Delete('sessions/:id')
  async remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  /**
   * Server-Sent Events stream of normalised transcript events.
   * Clients should subscribe from UI / voice agents to watch a session live.
   */
  @Get('sessions/:id/stream')
  async stream(
    @Param('id') id: string,
    @Query('from') _fromIgnored: string | undefined, // reserved for resume; v1 streams from start
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    try {
      // Validate the session exists before opening the stream
      this.service.get(id);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException('session not found', HttpStatus.NOT_FOUND);
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

    // Heartbeat so proxies don't close the connection during quiet stretches.
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);

    try {
      for await (const evt of this.service.tailEvents(id)) {
        if (closed) break;
        res.write(`event: event\ndata: ${JSON.stringify(evt)}\n\n`);
      }
      // After the tail ends, attach one final snapshot of the session status
      try {
        const session = this.service.get(id);
        res.write(`event: status\ndata: ${JSON.stringify({ status: session.status, exit_code: session.exit_code })}\n\n`);
      } catch { /* session may have been removed */ }
    } catch (err: any) {
      this.logger.warn(`stream error for ${id}: ${err.message}`);
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      close();
    }
  }
}
