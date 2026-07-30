import { Body, Controller, Get, HttpException, HttpStatus, Post, Query } from '@nestjs/common';
import { SessionUsageService, type BudgetConfig } from './session-usage.service';

/**
 * REST surface for the per-session token/$ budget.
 *
 *   GET  /api/v1/session/usage?session_id=X       → current usage + cap + computed pct
 *   POST /api/v1/session/budget {session_id, mode, limit, warn_at_pct?} → set the cap
 *   POST /api/v1/session/usage/reset {session_id} → zero the counters (e.g. after raising cap)
 */
@Controller('session')
export class SessionUsageController {
  constructor(private readonly usage: SessionUsageService) {}

  @Get('usage')
  async getUsage(@Query('session_id') sessionId: string) {
    if (!sessionId) throw new HttpException('session_id required', HttpStatus.BAD_REQUEST);
    const check = await this.usage.checkBudget(sessionId);
    return {
      usage: check.usage,
      budget: check.budget,
      pct: check.pct,
      over: check.over,
      warn: check.warn,
    };
  }

  @Post('budget')
  async setBudget(@Body() body: { session_id: string } & Partial<BudgetConfig>) {
    if (!body?.session_id) throw new HttpException('session_id required', HttpStatus.BAD_REQUEST);
    const next = await this.usage.setBudget(body.session_id, {
      mode: body.mode,
      limit: body.limit,
      warn_at_pct: body.warn_at_pct,
    });
    return { ok: true, budget: next };
  }

  @Post('usage/reset')
  async resetUsage(@Body() body: { session_id: string }) {
    if (!body?.session_id) throw new HttpException('session_id required', HttpStatus.BAD_REQUEST);
    await this.usage.resetUsage(body.session_id);
    return { ok: true };
  }
}
