import { Module } from '@nestjs/common';
import { CoordinatorController } from './coordinator.controller';

@Module({
  controllers: [CoordinatorController],
})
export class CoordinatorModule {}
