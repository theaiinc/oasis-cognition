import { Controller, Logger, Query, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RedisEventService } from './redis-event.service';

@Controller('events')
export class TimelineController {
  private readonly logger = new Logger(TimelineController.name);

  constructor(private readonly events: RedisEventService) {}

  @Sse('timeline')
  timeline(
    @Query('session_id') sessionId: string,
    @Query('backlog') backlog: string = '50',
  ): Observable<MessageEvent> {
    const backlogN = Math.max(0, Math.min(parseInt(backlog, 10) || 50, 200));

    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let lastId = '$'; // start from new events after subscription

      const run = async () => {
        try {
          if (!sessionId) {
            subscriber.error(new Error('session_id is required'));
            return;
          }

          // Send backlog first (chronological).
          if (backlogN > 0) {
            const items = await this.events.getBacklog(sessionId, backlogN);
            for (const e of items) {
              if (closed) return;
              subscriber.next({ data: e });
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
              subscriber.next({ data: item.event });
            }
          }
        } catch (err: any) {
          this.logger.warn(`Timeline stream error: ${err?.message || err}`);
          if (!closed) subscriber.error(err);
        }
      };

      void run();

      return () => {
        closed = true;
      };
    });
  }
}

