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
  ],
})
export class AppModule {}
