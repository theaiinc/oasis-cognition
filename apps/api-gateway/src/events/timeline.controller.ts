import { BadRequestException, Controller, Headers, Logger, Query, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RedisEventService } from './redis-event.service';

/** How often an idle timeline stream sends a keep-alive (under common proxies' ~100 s idle limit). */
export const TIMELINE_KEEPALIVE_MS = 20_000;

/** A stream entry id, as `after` / Last-Event-ID take it. */
const CURSOR = /^\d+-\d+$/;

@Controller('events')
export class TimelineController {
  private readonly logger = new Logger(TimelineController.name);

  constructor(private readonly events: RedisEventService) {}

  /**
   * GET /api/v1/events/timeline?session_id=…[&backlog=N][&after=<id>]
   *
   * Every event carries its stream id as the SSE `id`. A reader that lost its
   * connection resumes with `after=<last id>` (or the Last-Event-ID header): it gets
   * every event of the session after that id, and no backlog.
   */
  @Sse('timeline')
  timeline(
    @Query('session_id') sessionId: string,
    @Query('project_id') projectId?: string,
    @Query('backlog') backlog: string = '50',
    @Headers('last-event-id') lastEventId?: string,
    @Query('after') after?: string,
  ): Observable<MessageEvent> {
    const cursor = after || lastEventId;
    if (cursor && !CURSOR.test(cursor)) throw new BadRequestException('Invalid event cursor');
    const parsedBacklog = Number(backlog);
    const backlogN = Number.isFinite(parsedBacklog) ? Math.max(0, Math.min(parsedBacklog, 200)) : 50;

    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let lastId = cursor || '0-0';

      const run = async () => {
        try {
          if (!sessionId) {
            subscriber.error(new Error('session_id is required'));
            return;
          }

          // Without a cursor: the backlog up to now, then what comes after it.
          if (!cursor) lastId = await this.events.latestStreamId();
          if (!cursor && backlogN > 0) {
            const items = await this.events.getBacklog(sessionId, backlogN, lastId === '0-0' ? '+' : lastId);
            for (const e of items) {
              if (closed) return;
              if (projectId && e.project_id !== projectId) continue;
              subscriber.next({ id: e.stream_id, data: e });
            }
          }

          subscriber.next({ data: { event_type: 'TimelineConnected', session_id: sessionId, timestamp: new Date().toISOString(), payload: {} } });

          // Stream new events.
          while (!closed) {
            const batch = await this.events.readNextBatch(lastId);
            if (batch.length === 0) continue;
            for (const item of batch) {
              lastId = item.id;
              if (closed) return;
              if (item.event.session_id !== sessionId) continue;
              if (projectId && item.event.project_id !== projectId) continue;
              subscriber.next({ id: item.id, data: item.event });
            }
          }
        } catch (err: any) {
          this.logger.warn(`Timeline stream error: ${err?.message || err}`);
          if (!closed) subscriber.error(err);
        }
      };

      void run();

      // Keep-alive: an idle connection is otherwise cut by proxies without the reader
      // noticing. A named `ping` event isn't delivered to EventSource.onmessage; readers
      // that parse the raw stream see an event_type they don't handle and skip it.
      const keepAlive = setInterval(() => {
        if (!closed) {
          subscriber.next({ type: 'ping', data: { event_type: 'TimelineKeepAlive', session_id: sessionId, timestamp: new Date().toISOString(), payload: {} } });
        }
      }, TIMELINE_KEEPALIVE_MS);

      return () => {
        closed = true;
        clearInterval(keepAlive);
      };
    });
  }
}
