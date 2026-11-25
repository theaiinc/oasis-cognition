import { Controller, Post, Body, Logger, Req, Res, BadRequestException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RedisEventService } from '../events/redis-event.service';
import { InteractionService, InteractionRequest } from './interaction.service';

/** How long a sent message's id is remembered, so a resend of it starts no second turn. */
export const CLIENT_MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;
const CLIENT_MESSAGE_MAX = 5000;

/**
 * Recently accepted (session, client_message_id) pairs. A phone that lost its
 * connection right after sending can't tell whether the message arrived, so it
 * sends it again with the same id: the resend gets the first send's cursor back
 * and replays that turn's events instead of starting the turn twice.
 */
export class AcceptedMessages {
  private readonly seen = new Map<string, { event_cursor: Promise<string>; at: number }>();
  constructor(private readonly ttlMs = CLIENT_MESSAGE_TTL_MS, private readonly max = CLIENT_MESSAGE_MAX, private readonly now = () => Date.now()) {}

  get(sessionId: string, clientMessageId: string): Promise<string> | null {
    const key = `${sessionId}\u0000${clientMessageId}`;
    const hit = this.seen.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) { this.seen.delete(key); return null; }
    return hit.event_cursor;
  }

  /** Takes the cursor as a promise so a resend arriving while the first send is still being accepted is caught too. */
  remember(sessionId: string, clientMessageId: string, eventCursor: Promise<string>): void {
    this.seen.set(`${sessionId}\u0000${clientMessageId}`, { event_cursor: eventCursor, at: this.now() });
    // Map keeps insertion order: drop the oldest once over the cap.
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

@Controller('interaction')
export class InteractionController {
  private readonly logger = new Logger(InteractionController.name);
  private readonly accepted = new AcceptedMessages();

  constructor(private readonly interactionService: InteractionService, private readonly events: RedisEventService) {}

  @Post()
  async createInteraction(
    @Body() req: InteractionRequest,
    @Req() _expressReq: Request,
    @Res({ passthrough: true }) expressRes: Response,
  ): Promise<{ session_id: string; client_message_id: string; event_cursor: string; duplicate?: true }> {
    if (typeof req.user_message !== 'string' || !req.user_message.trim()) {
      throw new BadRequestException('user_message must be nonempty text');
    }
    // Must match what InteractionService.execute() uses (a fresh uuid when session_id
    // is absent), so the caller can subscribe to the id events are published under.
    const sessionId = req.session_id || uuidv4();
    req.session_id = sessionId;
    const suppliedId = typeof req.context?.client_message_id === 'string' && req.context.client_message_id ? req.context.client_message_id : null;
    if (suppliedId) {
      const first = this.accepted.get(sessionId, suppliedId);
      const firstCursor = first && await first.catch(() => null);
      if (firstCursor) {
        this.logger.log(`Duplicate message ignored: session=${sessionId}`);
        expressRes.status(HttpStatus.ACCEPTED);
        return { session_id: sessionId, client_message_id: suppliedId, event_cursor: firstCursor, duplicate: true };
      }
    }
    const clientMessageId = suppliedId || uuidv4();
    req.context = { ...(req.context || {}), client_message_id: clientMessageId };
    const cursorPromise = this.events.latestStreamId();
    if (suppliedId) this.accepted.remember(sessionId, suppliedId, cursorPromise);
    const eventCursor = await cursorPromise;
    this.logger.log(`New interaction: session=${sessionId}`);

    // Accept immediately — pipeline runs in the background.
    // All events (ThinkingChunkGenerated, ResponseGenerated, etc.) are
    // published to Redis Streams. Consumers should use the SSE endpoint:
    //
    //   GET /events/timeline?session_id={session_id}&after={event_cursor}
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

    return { session_id: sessionId, client_message_id: clientMessageId, event_cursor: eventCursor };
  }
}
