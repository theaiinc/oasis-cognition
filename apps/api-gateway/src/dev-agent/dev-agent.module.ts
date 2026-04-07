import { Module } from '@nestjs/common';
import { DevAgentController } from './dev-agent.controller';

@Module({
  controllers: [DevAgentController],
})
export class DevAgentModule {}
