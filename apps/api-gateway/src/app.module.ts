import { Module } from '@nestjs/common';
import { InteractionModule } from './interaction/interaction.module';
import { FeedbackModule } from './feedback/feedback.module';
import { MemoryModule } from './memory/memory.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { DevAgentModule } from './dev-agent/dev-agent.module';
import { HistoryModule } from './history/history.module';
import { ProjectModule } from './project/project.module';
import { VoiceProxyModule } from './voice-proxy/voice-proxy.module';
import { SessionModule } from './session/session.module';
import { SelfTeachingModule } from './self-teaching/self-teaching.module';
import { CodeGraphModule } from './code-graph/code-graph.module';
import { ComputerUseModule } from './computer-use/computer-use.module';
import { ArtifactModule } from './artifact/artifact.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { WebSearchModule } from './web-search/web-search.module';
import { AgentProfilesModule } from './agent-profiles/agent-profiles.module';
import { ProjectRolesModule } from './project-roles/project-roles.module';
import { FilesModule } from './files/files.module';
import { MissionsModule } from './missions/missions.module';
import { ModelsModule } from './models/models.module';
import { CoordinatorModule } from './coordinator/coordinator.module';
import { JanusModule } from './janus/janus.module';
import { ArcanaModule } from './arcana/arcana.module';

@Module({
  imports: [
    EventsModule,
    InteractionModule,
    FeedbackModule,
    MemoryModule,
    HealthModule,
    DevAgentModule,
    HistoryModule,
    ProjectModule,
    VoiceProxyModule,
    SessionModule,
    SelfTeachingModule,
    CodeGraphModule,
    ComputerUseModule,
    ArtifactModule,
    WorkflowsModule,
    WebSearchModule,
    AgentProfilesModule,
    ProjectRolesModule,
    FilesModule,
    MissionsModule,
    ModelsModule,
    CoordinatorModule,
    JanusModule,
    ArcanaModule,
  ],
})
export class AppModule {}
