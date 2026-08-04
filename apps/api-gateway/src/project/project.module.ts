import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { CoordinatorModule } from '../coordinator/coordinator.module';

@Module({
  imports: [CoordinatorModule],
  controllers: [ProjectController],
})
export class ProjectModule {}
