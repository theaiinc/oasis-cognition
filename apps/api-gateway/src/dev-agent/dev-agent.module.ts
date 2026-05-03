import { Module } from '@nestjs/common';
import { DevAgentController } from './dev-agent.controller';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  controllers: [DevAgentController],
})
export class DevAgentModule {}
