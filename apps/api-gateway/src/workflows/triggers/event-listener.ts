/**
 * Event-trigger listener.
 *
 * Subscribes to the existing `oasis:events` Redis Stream using a dedicated
 * XREAD BLOCK consumer. For each new event, asks the TriggersService to
 * fire any enabled event-type trigger whose filter matches.
 *
 * The listener is resilient: if Redis is down it logs and backs off; when
 * Redis recovers it resumes from the most recent id.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { TriggersService } from './triggers.service';

const STREAM_KEY = 'oasis:events';

@Injectable()
export class EventListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventListener.name);
  private reader: Redis | null = null;
  private stopped = false;

  constructor(private readonly triggers: TriggersService) {}

  async onModuleInit() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    this.reader = new Redis(url, {
      maxRetriesPerRequest: null,                 // required for blocking ops
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 500, 5000),
      lazyConnect: true,
    });
    this.reader.on('error', (err) => this.logger.debug(`reader error: ${err.message}`));
    this.reader.connect().catch(err => this.logger.warn(`reader connect failed: ${err.message}`));
    // Fire-and-forget consumer
    this.consumeLoop().catch(err => this.logger.error(`consumer crashed: ${err.message}`));
  }

  async onModuleDestroy() {
    this.stopped = true;
    try { await this.reader?.quit(); } catch { /* noop */ }
  }

  private async consumeLoop() {
    let lastId = '$';  // start from "right now" — don't replay backlog
    while (!this.stopped) {
      if (!this.reader || this.reader.status !== 'ready') {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      try {
        const res = await this.reader.xread('BLOCK', 5000, 'STREAMS', STREAM_KEY, lastId) as
          Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;  // block timeout
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            lastId = id;
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
            let payload: any = {};
            try { payload = obj.payload ? JSON.parse(obj.payload) : {}; } catch { /* ignore */ }
            const event = {
              event_id: obj.event_id || id,
              event_type: obj.event_type || 'unknown',
              session_id: obj.session_id,
              trace_id: obj.trace_id,
              timestamp: obj.timestamp,
              payload,
            };
            try {
              await this.triggers.fireMatchingEventTriggers(event);
            } catch (err: any) {
              this.logger.warn(`dispatch failed for event ${id}: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        if (!this.stopped) {
          this.logger.debug(`xread error (will retry): ${err.message}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  }
}
