import { Controller, Post, Body, Logger, Req, Res, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { InteractionService, InteractionRequest } from './interaction.service';

const KEEPALIVE_MS = parseInt(process.env.OASIS_INTERACTION_KEEPALIVE_MS || '12000', 10);
/** When 1, also treat res/socket stream 'close' as abort (can false-positive with chunked NDJSON on some stacks). */
const STRICT_STREAM_CLOSE_ABORT = process.env.OASIS_STRICT_STREAM_CLOSE_ABORT === '1';

@Controller('interaction')
export class InteractionController {
  private readonly logger = new Logger(InteractionController.name);

  constructor(private readonly interactionService: InteractionService) {}

  @Post()
  async createInteraction(
    @Body() req: InteractionRequest,
    @Req() expressReq: Request,
    @Res() expressRes: Response,
  ): Promise<void> {
    this.logger.log(`New interaction: session=${req.session_id || 'auto'}`);

    // Abort detection: prefer explicit socket/message teardown only. Do NOT use req.on('close') (fires
    // after body read). res.on('close') / socket.on('close') can also fire during normal chunked
    // responses on some Node/Docker stacks — false "stopped by client" right after RulesSnapshot.
    let streamCloseAbort = false;
    const markDisconnectedIfResponsePending = () => {
      if (!expressRes.writableEnded) {
        streamCloseAbort = true;
      }
    };
    if (STRICT_STREAM_CLOSE_ABORT) {
      expressRes.on('close', markDisconnectedIfResponsePending);
      expressReq.socket?.on('close', markDisconnectedIfResponsePending);
    }

    const isAborted = () => {
      if (STRICT_STREAM_CLOSE_ABORT) {
        if (streamCloseAbort || expressReq.destroyed) return true;
      }
      const sock = expressReq.socket;
      return sock != null && sock.destroyed;
    };

    expressRes.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    expressRes.setHeader('Cache-Control', 'no-cache');
    expressRes.setHeader('X-Content-Type-Options', 'nosniff');
    expressRes.status(200);

    const writeKeepalive = () => {
      if (expressRes.writableEnded) return;
      try {
        expressRes.write(JSON.stringify({ _oasis_keepalive: true }) + '\n');
      } catch {
        /* client gone */
      }
    };

    if (typeof (expressRes as any).flushHeaders === 'function') {
      (expressRes as any).flushHeaders();
    }

    writeKeepalive();
    const hb = setInterval(writeKeepalive, KEEPALIVE_MS);

    const finishError = (e: unknown) => {
      if (expressRes.writableEnded) return;
      const status = e instanceof HttpException ? e.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      const body = e instanceof HttpException ? e.getResponse() : { error: 'Reasoning pipeline failed', detail: (e as Error)?.message };
      try {
        expressRes.write(JSON.stringify({ _oasis_error: true, status, body }) + '\n');
        expressRes.end();
      } catch {
        /* ignore */
      }
    };

    try {
      const result = await this.interactionService.execute(req, isAborted);
      clearInterval(hb);
      if (!expressRes.writableEnded) {
        expressRes.write(JSON.stringify(result) + '\n');
        expressRes.end();
      }
    } catch (e: unknown) {
      clearInterval(hb);
      finishError(e);
    } finally {
      clearInterval(hb);
      if (STRICT_STREAM_CLOSE_ABORT) {
        expressRes.off('close', markDisconnectedIfResponsePending);
        expressReq.socket?.off('close', markDisconnectedIfResponsePending);
      }
    }
  }
}
