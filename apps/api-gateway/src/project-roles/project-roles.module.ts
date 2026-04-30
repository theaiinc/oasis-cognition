import { Module } from '@nestjs/common';
import { AgentProfilesModule } from '../agent-profiles/agent-profiles.module';
import { ProjectRolesController } from './project-roles.controller';
import { ProjectRolesService } from './project-roles.service';

@Module({
  imports: [AgentProfilesModule],
  controllers: [ProjectRolesController],
  providers: [ProjectRolesService],
  exports: [ProjectRolesService],
})
export class ProjectRolesModule {}
