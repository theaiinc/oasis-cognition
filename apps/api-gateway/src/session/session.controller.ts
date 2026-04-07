import { Controller, Post, Get, Body, Query, Logger } from '@nestjs/common';
import { SessionConfigService } from './session.service';

@Controller('session')
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(private readonly sessionConfig: SessionConfigService) {}

  @Post('config')
  async setConfig(
    @Body() body: { session_id: string; autonomous_mode?: boolean; autonomous_max_duration_hours?: number },
  ) {
    if (!body.session_id) {
      return { ok: false, error: 'session_id required' };
    }
    this.sessionConfig.setConfig(body.session_id, {
      autonomous_mode: body.autonomous_mode,
      autonomous_max_duration_hours: body.autonomous_max_duration_hours,
    });
    this.logger.log(`Session config updated: ${body.session_id} autonomous=${body.autonomous_mode}`);
    return { ok: true };
  }

  @Get('config')
  async getConfig(@Query('session_id') sessionId: string) {
    if (!sessionId) {
      return { config: { autonomous_mode: false, autonomous_max_duration_hours: 6 } };
    }
    const config = this.sessionConfig.getConfig(sessionId);
    return { config };
  }
}
