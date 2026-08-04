import type { CoordinatorTask, WorkerBackend } from './coordinator/types';

/**
 * Stub host CLI backend used by the coordinator to estimate cost/feasibility.
 * Actual spawning is delegated to ExternalAgentsService at dispatch time.
 */
export class HostCliBackend implements WorkerBackend {
  async spawn(sessionId: string, task: CoordinatorTask, parentJobId: string): Promise<string> {
    console.log(`HostCliBackend.spawn(session=${sessionId}, task=${task.id}, job=${parentJobId})`);
    return `child-${task.id}-${Date.now()}`;
  }

  async checkStatus(_handle: string): Promise<{ done: boolean; error?: string }> {
    return { done: true };
  }

  async kill(_handle: string): Promise<void> {
    // No-op stub
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
