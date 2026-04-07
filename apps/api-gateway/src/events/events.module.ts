import { Module, Global } from '@nestjs/common';
import { RedisEventService } from './redis-event.service';
import { LangfuseService } from './langfuse.service';
import { TimelineController } from './timeline.controller';

@Global()
@Module({
  controllers: [TimelineController],
  providers: [RedisEventService, LangfuseService],
  exports: [RedisEventService, LangfuseService],
})
export class EventsModule {}
