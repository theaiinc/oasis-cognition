import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { WorkflowsController } from './workflows.controller';
import { WorkflowsService, RUN_QUEUE } from './workflows.service';
import { TriggersService } from './triggers/triggers.service';
import { WorkflowRunsWorker } from './triggers/cron-scheduler';
import { EventListener } from './triggers/event-listener';
import { WorkflowStore } from './store/redis-store';

// Register all node executors at module import time (side-effect imports).
import { registerBuiltins } from './nodes/builtin';
import { registerHttpNode } from './nodes/http';
import { registerMcpToolNode } from './nodes/mcp-tool';

registerBuiltins();
registerHttpNode();
registerMcpToolNode();

function parseRedisUrl(url: string): { host: string; port: number; db?: number } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: u.port ? parseInt(u.port, 10) : 6379,
      db: u.pathname && u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) : undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: parseRedisUrl(process.env.REDIS_URL || 'redis://localhost:6379'),
      }),
    }),
    BullModule.registerQueue({ name: RUN_QUEUE }),
  ],
  controllers: [WorkflowsController],
  providers: [
    WorkflowStore,
    WorkflowsService,
    TriggersService,
    WorkflowRunsWorker,
    EventListener,
  ],
  exports: [WorkflowsService, TriggersService],
})
export class WorkflowsModule {}
