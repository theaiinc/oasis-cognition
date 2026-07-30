import { Module } from '@nestjs/common';
import { ArcanaController } from './arcana.controller';
import { ArcanaService } from './arcana.service';

@Module({
  controllers: [ArcanaController],
  providers: [ArcanaService],
  exports: [ArcanaService],
})
export class ArcanaModule {}
