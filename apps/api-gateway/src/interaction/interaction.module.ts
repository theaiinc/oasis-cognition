import { Module } from '@nestjs/common';
import { InteractionController } from './interaction.controller';
import { InteractionService } from './interaction.service';
import { SessionModule } from '../session/session.module';
import { AgentProfilesModule } from '../agent-profiles/agent-profiles.module';
import { ProjectRolesModule } from '../project-roles/project-roles.module';

@Module({
  imports: [SessionModule, AgentProfilesModule, ProjectRolesModule],
  controllers: [InteractionController],
  providers: [InteractionService],
})
export class InteractionModule {}
