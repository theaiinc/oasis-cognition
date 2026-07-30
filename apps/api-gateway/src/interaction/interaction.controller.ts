import { Controller, Post, Body, Logger, Req, Res, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { InteractionService, InteractionRequest } from './interaction.service';

@Controller('interaction')
export class InteractionController {
  private readonly logger = new Logger(InteractionController.name);

  constructor(private readonly interactionService: InteractionService) {}

  @Post()
  async createInteraction(
    @Body() req: InteractionRequest,
    @Req() _expressReq: Request,
    @Res({ passthrough: true }) expressRes: Response,
  ): Promise<{ session_id: string }> {
    const sessionId = req.session_id || 'auto';
    this.logger.log(`New interaction: session=${sessionId}`);

    // Accept immediately — pipeline runs in the background.
    // All events (ThinkingChunkGenerated, ResponseGenerated, etc.) are
    // published to Redis Streams. Consumers should use the SSE endpoint:
    //
    //   GET /events/timeline?session_id={session_id}
    //
    // This decouples the HTTP request lifecycle from potentially long
    // model inference (minutes), so curl / CLI / any HTTP client works
    // without holding the connection open.

    expressRes.status(HttpStatus.ACCEPTED);

    // Fire the pipeline in the background (no await).
    // Errors are published as PipelineFailed events to the stream.
    this.interactionService.execute(req, () => false).catch((err) => {
      this.logger.error(`Background pipeline failed: ${err?.message || err}`);
    });

    return { session_id: sessionId };
  }
}
