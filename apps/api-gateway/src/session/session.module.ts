import { Module } from '@nestjs/common';
import { SessionConfigService } from './session.service';
import { SessionController } from './session.controller';

@Module({
  controllers: [SessionController],
  providers: [SessionConfigService],
  exports: [SessionConfigService],
})
export class SessionModule {}
