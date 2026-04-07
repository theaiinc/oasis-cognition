import { Module } from '@nestjs/common';
import { CodeGraphController } from './code-graph.controller';

@Module({
  controllers: [CodeGraphController],
})
export class CodeGraphModule {}
