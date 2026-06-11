/**
 * ModelsModule — exposes the model variant registry.
 */
import { Module } from '@nestjs/common';
import { ModelsController } from './models.controller';

@Module({
  controllers: [ModelsController],
})
export class ModelsModule {}
