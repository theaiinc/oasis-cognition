import { Controller, Post, Get, Delete, Body, Param, Query, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const MOBILE_RELAY_URL = process.env.MOBILE_RELAY_URL || 'http://localhost:8015';

@Controller('dev-agent')
export class DevAgentController {
  private readonly logger = new Logger(DevAgentController.name);

  @Get('worktrees')
  async listWorktrees() {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/worktrees`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Dev-agent unavailable: ${err.message}`);
      throw new HttpException(
        'Dev-agent is not running. Start it with: ./scripts/start-dev-agent.sh',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get('diff/:worktreeId')
  async getDiff(@Param('worktreeId') worktreeId: string) {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/diff/${worktreeId}`, { timeout: 15000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to get diff',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('apply')
  async applyChanges(@Body() body: { worktree_id: string; commit_message?: string }) {
    this.logger.log(`Applying changes from worktree: ${body.worktree_id}`);
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/apply`, body, { timeout: 30000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to apply changes',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('worktree/:worktreeId')
  async discardWorktree(@Param('worktreeId') worktreeId: string) {
    this.logger.log(`Discarding worktree: ${worktreeId}`);
    try {
      const res = await axios.delete(`${DEV_AGENT_URL}/internal/dev-agent/worktree/${worktreeId}`, { timeout: 15000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to discard worktree',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('snapshots/create')
  async createSnapshot(@Body() body: { session_id: string; iteration_count?: number }) {
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/snapshots/create`, body, { timeout: 30000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to create snapshot',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('snapshots/restore')
  async restoreSnapshot(@Body() body: { snapshot_id: string; session_id: string }) {
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/snapshots/restore`, body, { timeout: 60000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to restore snapshot',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('snapshots')
  async listSnapshots(@Query('session_id') sessionId: string) {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/snapshots`, {
        params: { session_id: sessionId },
        timeout: 10000,
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to list snapshots',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Tool Execution Proxy (forwards to dev-agent execute endpoint) ────────

  @Post('execute')
  async executeAction(@Body() body: Record<string, any>) {
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/execute`, body, { timeout: 15000 });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Dev-agent execute failed: ${err.message}`);
      throw new HttpException(
        err.response?.data || 'Dev-agent execute failed',
        err.response?.status || HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  // ── Mobile Pairing Proxy (forwards to mobile-relay on port 8015) ────────

  @Post('mobile/pair/initiate')
  async initiateMobilePairing(@Body() body: { duration_hours?: number }) {
    try {
      const res = await axios.post(`${MOBILE_RELAY_URL}/pair/initiate`, body, { timeout: 35000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Mobile relay unavailable. Start it with: cd apps/mobile-relay && npm run start:dev',
        err.response?.status || HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Delete('mobile/pair')
  async revokeMobilePairing() {
    try {
      const res = await axios.delete(`${MOBILE_RELAY_URL}/pair`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to revoke pairing',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('mobile/pair/status')
  async getMobilePairingStatus() {
    try {
      const res = await axios.get(`${MOBILE_RELAY_URL}/pair/status`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      // Return idle state if relay is not running or unreachable
      const networkErrors = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN'];
      if (networkErrors.includes(err.code) || err.code === 'ERR_BAD_RESPONSE' || !err.response) {
        return { state: 'idle' };
      }
      throw new HttpException(
        err.response?.data || 'Failed to get pairing status',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('mobile/pair/screen-access')
  async setMobileScreenAccess(@Body() body: { grant: boolean }) {
    try {
      const res = await axios.post(`${MOBILE_RELAY_URL}/pair/screen-access`, body, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to set screen access',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Tunnel Management Proxy ─────────────────────────────────────────────

  @Get('tunnel/status')
  async getTunnelStatus() {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/tunnel/status`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED') {
        return { active: false, url: null };
      }
      throw new HttpException(
        err.response?.data || 'Failed to get tunnel status',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
