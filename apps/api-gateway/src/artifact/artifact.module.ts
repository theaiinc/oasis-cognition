import { Module } from '@nestjs/common';
import { ArtifactController, ProjectsController, SpeakersController } from './artifact.controller';

@Module({
  controllers: [ArtifactController, ProjectsController, SpeakersController],
})
export class ArtifactModule {}
