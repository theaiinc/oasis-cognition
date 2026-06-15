import { Controller, Get, Delete, Query, Logger } from '@nestjs/common';
import { RedisEventService } from '../events/redis-event.service';

@Controller('history')
export class HistoryController {
  private readonly logger = new Logger(HistoryController.name);

  constructor(private readonly events: RedisEventService) {}

  /** List all chat sessions (most recent first). */
  @Get('sessions')
  async listSessions() {
    const sessions = await this.events.listSessions();
    return { sessions };
  }

  /** Get full chat history for a session. Supports pagination via page/limit. */
  @Get('messages')
  async getMessages(
    @Query('session_id') sessionId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!sessionId) {
      return { messages: [] };
    }
    const pageNum = page ? Math.max(0, parseInt(page, 10)) : 0;
    const limitNum = limit ? Math.max(1, Math.min(parseInt(limit, 10), 200)) : 50;
    const messages = await this.events.getHistory(sessionId, pageNum, limitNum);
    const total = await this.events.getHistoryCount(sessionId).catch(() => messages.length);
    return { session_id: sessionId, messages, total, page: pageNum, limit: limitNum, has_more: (pageNum + 1) * limitNum < total };
  }

  /** Delete a session's history. */
  @Delete('session')
  async deleteSession(@Query('session_id') sessionId: string) {
    if (!sessionId) {
      return { ok: false };
    }
    await this.events.deleteSession(sessionId);
    return { ok: true };
  }
}
