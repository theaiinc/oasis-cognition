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

  /** Get full chat history for a session. */
  @Get('messages')
  async getMessages(@Query('session_id') sessionId: string) {
    if (!sessionId) {
      return { messages: [] };
    }
    const messages = await this.events.getHistory(sessionId);
    return { session_id: sessionId, messages };
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
