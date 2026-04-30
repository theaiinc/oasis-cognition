/**
 * BullMQ worker for the `workflow-runs` queue.
 *
 * Handles two job kinds:
 *   • `run` — a pre-staged run (created by WorkflowsService.enqueueRun)
 *     whose run_id is the jobId. Execute it via the engine.
 *   • `cron-trigger` — fired by a repeatable cron job; enqueues a fresh
 *     run bound to the originating trigger.
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { WorkflowsService, RUN_QUEUE } from '../workflows.service';

interface CronJobData { trigger_id: string; workflow_id: string; }
interface RunJobData {
  workflow_id: string;
  trigger_id?: string;
  trigger_type?: 'cron' | 'event' | 'manual';
  input?: any;
  context?: Record<string, any>;
}

@Processor(RUN_QUEUE)
export class WorkflowRunsWorker extends WorkerHost {
  private readonly logger = new Logger(WorkflowRunsWorker.name);

  constructor(private readonly workflows: WorkflowsService) { super(); }

  async process(job: Job<RunJobData | CronJobData>): Promise<void> {
    if (job.name === 'cron-trigger') {
      const d = job.data as CronJobData;
      this.logger.log(`cron fired for trigger ${d.trigger_id}`);
      await this.workflows.enqueueRun(d.workflow_id, undefined, {
        trigger_id: d.trigger_id,
        trigger_type: 'cron',
      });
      return;
    }
    if (job.name === 'run') {
      const runId = job.id as string;
      const d = job.data as RunJobData;
      try {
        await this.workflows.executeJob(d, runId);
      } catch (err: any) {
        this.logger.error(`executeJob ${runId} threw: ${err.message}`);
        throw err;
      }
      return;
    }
    this.logger.warn(`unknown job kind: ${job.name}`);
  }
}
