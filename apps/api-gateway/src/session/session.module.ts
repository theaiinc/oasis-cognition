import { Module } from '@nestjs/common';
import { SessionConfigService } from './session.service';
import { SessionController } from './session.controller';
import { SessionWorktreeService } from './session-worktree.service';
import { SessionsActivityController } from './sessions-activity.controller';
import { SessionUsageService } from './session-usage.service';
import { SessionUsageController } from './session-usage.controller';
import { PricingService } from './pricing.service';
import { PricingController } from './pricing.controller';

@Module({
  controllers: [SessionController, SessionsActivityController, SessionUsageController, PricingController],
  providers: [SessionConfigService, SessionWorktreeService, SessionUsageService, PricingService],
  exports: [SessionConfigService, SessionWorktreeService, SessionUsageService, PricingService],
})
export class SessionModule {}
