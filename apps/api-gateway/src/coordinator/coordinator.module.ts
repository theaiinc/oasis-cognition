/**
 * Coordinator module — registers all coordinator services and controllers.
 *
 * Tasks are dispatched to Yggdrasil runners (Ratatoskr daemons) via the
 * YggdrasilBridgeService. Each runner registers with its capabilities
 * (agent, shell, llm, gpu, etc.) and the bridge dispatches tasks to the
 * best available runner. The legacy WorkerBackend abstraction (HostCliBackend
 * / ContainerBackend) is retained for future direct-execution fallback but
 * is no longer the primary dispatch path.
 */

import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SessionModule } from '../session/session.module';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { CoordinatorPreflightService } from './coordinator-preflight.service';
import { HostCapacityService } from './host-capacity.service';
import { HostCliBackend } from './host-cli-backend';
import { ContainerBackend } from './container-backend';
import { JobUsageService } from './job-usage.service';
import { JobBudgetService } from './job-budget.service';
import { YggdrasilBridgeService } from './yggdrasil-bridge.service';

@Module({
  imports: [EventsModule, SessionModule],
  controllers: [CoordinatorController],
  providers: [
    CoordinatorService,
    CoordinatorPreflightService,
    HostCapacityService,
    HostCliBackend,
    ContainerBackend,
    JobUsageService,
    JobBudgetService,
    YggdrasilBridgeService,
  ],
  exports: [
    CoordinatorService,
    CoordinatorPreflightService,
    HostCapacityService,
    JobUsageService,
    JobBudgetService,
    YggdrasilBridgeService,
  ],
})
export class CoordinatorModule {}
