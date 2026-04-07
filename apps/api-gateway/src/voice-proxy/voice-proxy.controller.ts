import {
  Controller,
  Post,
  Get,
  Delete,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import axios from 'axios';

const VOICE_AGENT_URL = process.env.VOICE_AGENT_URL || 'http://voice-agent:8090';

@Controller('voice-proxy')
export class VoiceProxyController {
  private readonly logger = new Logger(VoiceProxyController.name);

  private async proxy(
    method: 'get' | 'post' | 'delete',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
  ) {
    const url = new URL(path, VOICE_AGENT_URL);
    if (query) {
      Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    try {
      const res = await axios({
        method,
        url: url.toString(),
        data: body,
        timeout: 15000,
      });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Voice agent proxy error: ${err.message}`);
      throw new HttpException(
        err.response?.data || 'Voice agent unavailable',
        err.response?.status || HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Post('join')
  async join(
    @Query('room_name') roomName = 'oasis-voice',
    @Query('session_id') sessionId?: string,
  ) {
    const query: Record<string, string> = { room_name: roomName };
    if (sessionId) query.session_id = sessionId;
    return this.proxy('post', '/join', query);
  }

  @Post('token')
  async token(
    @Query('room_name') roomName = 'oasis-voice',
    @Query('participant_name') participantName = 'user',
  ) {
    return this.proxy('post', '/token', {
      room_name: roomName,
      participant_name: participantName,
    });
  }

  @Get('voice-id/status')
  async voiceIdStatus() {
    return this.proxy('get', '/voice-id/status');
  }

  @Post('voice-id/enroll')
  async voiceIdEnroll() {
    return this.proxy('post', '/voice-id/enroll');
  }

  @Delete('voice-id/clear')
  async voiceIdClear() {
    return this.proxy('delete', '/voice-id/clear');
  }

  @Get('health')
  async health() {
    return this.proxy('get', '/health');
  }
}
