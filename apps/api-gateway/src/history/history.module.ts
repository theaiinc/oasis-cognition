import { Module } from '@nestjs/common';
import { HistoryController } from './history.controller';

@Module({
  controllers: [HistoryController],
})
export class HistoryModule {}
