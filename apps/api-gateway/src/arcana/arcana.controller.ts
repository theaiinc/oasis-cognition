import { Controller, Get } from '@nestjs/common';
import { ArcanaService } from './arcana.service';

@Controller('health')
export class ArcanaController {
  constructor(private readonly arcana: ArcanaService) {}

  @Get('arcana')
  health() {
    return this.arcana.health();
  }
}
