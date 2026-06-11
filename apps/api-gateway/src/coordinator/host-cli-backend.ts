/**
 * Host CLI backend — implements WorkerBackend by calling the existing
 * ExternalAgentsService to spawn host subprocesses with git worktrees.
 *
 * This is the v1 default worker backend. A future ContainerBackend will
 * implement the same interface against a Docker agent pool managed by
 * the Yggdrasil compose stack.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CoordinatorTask, WorkerBackend } from './coordinator.types';

/**
 * Stub host CLI backend used by the coordinator to estimate cost/feasibility.
 * Actual spawning delegates to ExternalAgentsService at dispatch time.
 */
@Injectable()
export class HostCliBackend implements WorkerBackend {
  private readonly logger = new Logger(HostCliBackend.name);

  async spawn(sessionId: string, task: CoordinatorTask, parentJobId: string): Promise<string> {
    this.logger.log(`HostCliBackend.spawn(session=${sessionId}, task=${task.id}, job=${parentJobId})`);
    // The real ExternalAgentsService.createSession call happens in
    // CoordinatorService.dispatchApprovedJob — this is a stub for the
    // WorkerBackend interface that Yggdrasil bridge tracks for capacity.
    return `child-${task.id}-${Date.now()}`;
  }

  async checkStatus(handle: string): Promise<{ done: boolean; error?: string }> {
    return { done: true };
  }

  async kill(handle: string): Promise<void> {
    this.logger.log(`HostCliBackend.kill(${handle})`);
  }

  estimateCost(task: CoordinatorTask): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number } {
    const goalLen = task.goal?.length ?? 0;
    const lowInput = Math.round(goalLen * 0.5);
    const highInput = Math.round(goalLen * 2);
    return {
      usd_low: task.est_cost_usd ? task.est_cost_usd * 0.5 : lowInput * 0.000001,
      usd_high: task.est_cost_usd ?? highInput * 0.000003,
      tokens_low: lowInput + Math.round(lowInput * 0.3),
      tokens_high: highInput + Math.round(highInput * 0.6),
    };
  }
}
