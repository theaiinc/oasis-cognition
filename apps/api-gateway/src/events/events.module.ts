import { Module, Global } from '@nestjs/common';
import { RedisEventService } from './redis-event.service';
import { TimelineController } from './timeline.controller';
import { ProjectContextService } from '../context/project-context.service';

@Global()
@Module({
  controllers: [TimelineController],
  providers: [RedisEventService, ProjectContextService],
  exports: [RedisEventService, ProjectContextService],
})
export class EventsModule {}
