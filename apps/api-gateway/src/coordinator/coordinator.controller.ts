import { Body, Controller, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import axios from 'axios';

const OASIS_AGENT_URL = process.env.OASIS_AGENT_URL || 'http://oasis-agent:8020';

@Controller('coordinator/jobs')
export class CoordinatorController {
  private async forward(method: 'post', path: string, body?: unknown) {
    try {
      const response = await axios.request({
        method,
        url: `${OASIS_AGENT_URL}/api/v1/coordinator/jobs/${path}`,
        data: body,
        timeout: 15_000,
      });
      return response.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Coordinator service unavailable',
        err.response?.status || HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() body: { user_limit?: number }) {
    return this.forward('post', `${encodeURIComponent(id)}/approve`, body);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.forward('post', `${encodeURIComponent(id)}/cancel`, {});
  }
}
