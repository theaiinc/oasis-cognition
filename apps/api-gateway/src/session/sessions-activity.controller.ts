import { Controller, Get, Query } from '@nestjs/common';
import { RedisEventService } from '../events/redis-event.service';

/**
 * GET /api/v1/sessions/active — every session_id currently mid-interaction,
 * with the timestamp it started. Powers the cross-tab "🟢 working now" dot
 * on HistoryPanel rows + the sidebar History-icon badge.
 *
 * Read-only and cheap: a single Redis HGETALL plus a stale-entry filter.
 * Polled by the UI at ~5s intervals.
 */
@Controller('sessions')
export class SessionsActivityController {
  constructor(private readonly events: RedisEventService) {}

  @Get('active')
  async getActive(@Query('project_id') projectId?: string) {
    return { active: await this.events.getActiveSessions(projectId?.trim() || undefined) };
  }
}
