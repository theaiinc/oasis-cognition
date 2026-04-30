import { Module } from '@nestjs/common';
import { AgentProfilesController } from './agent-profiles.controller';
import { AgentProfilesService } from './agent-profiles.service';

@Module({
  controllers: [AgentProfilesController],
  providers: [AgentProfilesService],
  exports: [AgentProfilesService],
})
export class AgentProfilesModule {}
