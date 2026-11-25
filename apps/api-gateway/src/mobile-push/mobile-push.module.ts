import { Module } from '@nestjs/common';
import { MobilePushController } from './mobile-push.controller';
import { MobilePushService } from './mobile-push.service';
import { PushSubscriptionStore } from './push-subscription.store';

@Module({
  controllers: [MobilePushController],
  providers: [MobilePushService, PushSubscriptionStore],
  exports: [MobilePushService],
})
export class MobilePushModule {}
