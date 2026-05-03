import { Module, forwardRef } from '@nestjs/common';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';
import { InteractionModule } from '../interaction/interaction.module';

@Module({
  imports: [forwardRef(() => InteractionModule)],
  controllers: [MissionsController],
  providers: [MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
