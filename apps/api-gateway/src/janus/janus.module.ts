import { Module } from '@nestjs/common';
import { JanusController } from './janus.controller';
import { JanusService } from './janus.service';

@Module({
  controllers: [JanusController],
  providers: [JanusService],
  exports: [JanusService],
})
export class JanusModule {}
