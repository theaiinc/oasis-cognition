import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Optional, Param, Post, Put } from '@nestjs/common';
import { editApprovalGate, type EditApprovalGate } from './edit-approval';

/** Injection token, for tests. */
export const EDIT_APPROVAL_GATE = 'EDIT_APPROVAL_GATE';

/**
 * The chat's "Review edits" setting and its changes waiting for approval (edit-approval.ts).
 *   GET  /api/v1/sessions/:sessionId/edit-approval            → { enabled, pending }
 *   PUT  /api/v1/sessions/:sessionId/edit-approval            { enabled }
 *   POST /api/v1/sessions/:sessionId/edit-approval/:approvalId { decision: approved|rejected, reason? }
 */
@Controller('sessions')
export class EditApprovalController {
  private readonly gate: EditApprovalGate;

  constructor(@Optional() @Inject(EDIT_APPROVAL_GATE) gate?: EditApprovalGate) {
    this.gate = gate || editApprovalGate();
  }

  private assertSession(sessionId: string): void {
    if (!sessionId || !/^[\w.:-]{1,128}$/.test(sessionId)) throw new NotFoundException('session_not_found');
  }

  @Get(':sessionId/edit-approval')
  async get(@Param('sessionId') sessionId: string) {
    this.assertSession(sessionId);
    return { session_id: sessionId, enabled: await this.gate.enabledFor(sessionId), pending: await this.gate.pending(sessionId) };
  }

  @Put(':sessionId/edit-approval')
  async set(@Param('sessionId') sessionId: string, @Body() body: { enabled?: unknown }) {
    this.assertSession(sessionId);
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    await this.gate.store.setEnabled(sessionId, body.enabled);
    return { session_id: sessionId, enabled: body.enabled };
  }

  @Post(':sessionId/edit-approval/:approvalId')
  async decide(
    @Param('sessionId') sessionId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: { decision?: unknown; reason?: unknown },
  ) {
    this.assertSession(sessionId);
    if (!/^[\w-]{8,64}$/.test(approvalId || '')) throw new NotFoundException('approval_not_found');
    const decision = body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') throw new BadRequestException('decision must be "approved" or "rejected"');
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    // Not pending any more: answered in another tab, timed out, or the turn was stopped.
    if (!(await this.gate.decide(sessionId, approvalId, decision, reason))) throw new NotFoundException('approval_not_found');
    return { session_id: sessionId, approval_id: approvalId, decision };
  }
}
