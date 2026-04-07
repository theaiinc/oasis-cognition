import { Module } from '@nestjs/common';
import { VoiceProxyController } from './voice-proxy.controller';

@Module({
  controllers: [VoiceProxyController],
})
export class VoiceProxyModule {}
