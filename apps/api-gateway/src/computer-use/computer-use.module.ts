import { Module } from '@nestjs/common';
import { ComputerUseController } from './computer-use.controller';
import { LocalMacOSRuntime } from './local-macos-runtime';
import { ComputerUseRuntimeToken } from './computer-use-runtime.interface';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';

@Module({
  controllers: [ComputerUseController],
  providers: [
    {
      provide: ComputerUseRuntimeToken,
      useFactory: () => new LocalMacOSRuntime(DEV_AGENT_URL),
    },
    {
      provide: 'DEV_AGENT_URL',
      useValue: DEV_AGENT_URL,
    },
  ],
  exports: ['DEV_AGENT_URL'],
})
export class ComputerUseModule {}
