import { Module } from '@nestjs/common';
import { ExternalAgentsController } from './external-agents.controller';
import { ExternalAgentsService } from './external-agents.service';
import { AgentProfilesModule } from '../agent-profiles/agent-profiles.module';
import { ProjectRolesModule } from '../project-roles/project-roles.module';

@Module({
  imports: [AgentProfilesModule, ProjectRolesModule],
  controllers: [ExternalAgentsController],
  providers: [ExternalAgentsService],
  exports: [ExternalAgentsService],
})
export class ExternalAgentsModule {}
