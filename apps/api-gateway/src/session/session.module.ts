import { Module } from '@nestjs/common';
import { SessionConfigService } from './session.service';
import { SessionController } from './session.controller';
import { SessionWorktreeService } from './session-worktree.service';
import { SessionsActivityController } from './sessions-activity.controller';

@Module({
  controllers: [SessionController, SessionsActivityController],
  providers: [SessionConfigService, SessionWorktreeService],
  exports: [SessionConfigService, SessionWorktreeService],
})
export class SessionModule {}
