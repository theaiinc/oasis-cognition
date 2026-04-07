import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';

@Module({
  controllers: [MemoryController],
})
export class MemoryModule {}
