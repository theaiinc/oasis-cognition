import { Module } from '@nestjs/common';
import { ComputerUseController } from './computer-use.controller';

@Module({
  controllers: [ComputerUseController],
})
export class ComputerUseModule {}
