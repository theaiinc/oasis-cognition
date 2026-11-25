import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import { MobilePushService } from './mobile-push.service';
import { isDeviceId, parseSubscription } from './mobile-push.types';

/** Owner key for registrations: this gateway has a single owner. */
export const PUSH_OWNER = 'owner';

@Controller('mobile-push')
export class MobilePushController {
  constructor(private readonly push: MobilePushService) {}

  /** Whether push is set up, and the public key a phone subscribes with. */
  @Get('config')
  config() {
    return { enabled: this.push.enabled, public_key: this.push.publicKey };
  }

  @Post('subscriptions')
  async subscribe(@Body() body: { device_id?: unknown; subscription?: unknown }) {
    if (!this.push.enabled) throw new ServiceUnavailableException('push_not_configured');
    if (!isDeviceId(body?.device_id)) throw new BadRequestException('device_id is invalid');
    const subscription = parseSubscription(body?.subscription);
    if (!subscription) throw new BadRequestException('subscription is not a Web Push subscription from a known push service');
    await this.push.register(PUSH_OWNER, body.device_id, subscription);
    return { ok: true };
  }

  @Delete('subscriptions/:deviceId')
  async unsubscribe(@Param('deviceId') deviceId: string) {
    if (!isDeviceId(deviceId)) throw new BadRequestException('device_id is invalid');
    return { ok: true, removed: await this.push.unregister(PUSH_OWNER, deviceId) };
  }

  @Post('subscriptions/:deviceId/test')
  @HttpCode(200)
  async test(@Param('deviceId') deviceId: string) {
    if (!this.push.enabled) throw new ServiceUnavailableException('push_not_configured');
    if (!isDeviceId(deviceId)) throw new BadRequestException('device_id is invalid');
    if (!(await this.push.sendTest(PUSH_OWNER, deviceId))) throw new NotFoundException('device_not_registered');
    return { ok: true };
  }
}
