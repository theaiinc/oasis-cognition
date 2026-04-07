import { Module } from '@nestjs/common';
import { SelfTeachingController } from './self-teaching.controller';
import { SelfTeachingService } from './self-teaching.service';

@Module({
  controllers: [SelfTeachingController],
  providers: [SelfTeachingService],
})
export class SelfTeachingModule {}

