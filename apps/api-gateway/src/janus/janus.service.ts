import { Injectable } from '@nestjs/common';
import axios from 'axios';

export interface JanusHealth {
  configured: boolean;
  available: boolean;
  status: string;
  error?: string;
}

@Injectable()
export class JanusService {
  private readonly baseUrl = (process.env.JANUS_BASE_URL || '').trim().replace(/\/+$/, '');
  private readonly timeoutMs = Number(process.env.JANUS_HEALTH_TIMEOUT_MS || 2000);

  async health(): Promise<JanusHealth> {
    if (!this.baseUrl) {
      return { configured: false, available: false, status: 'disabled' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/api/status`, {
        timeout: this.timeoutMs,
      });
      const body = response.data as Record<string, unknown> | undefined;
      const status = typeof body?.status === 'string'
        ? body.status
        : typeof body?.state === 'string'
          ? body.state
          : 'ok';
      return { configured: true, available: true, status };
    } catch (err: any) {
      return {
        configured: true,
        available: false,
        status: 'unavailable',
        error: err?.code || err?.message || 'request failed',
      };
    }
  }
}
