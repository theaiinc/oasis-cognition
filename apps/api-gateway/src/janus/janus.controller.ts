import { Controller, Get } from '@nestjs/common';
import { JanusService } from './janus.service';

@Controller('health')
export class JanusController {
  constructor(private readonly janus: JanusService) {}

  @Get('janus')
  health() {
    return this.janus.health();
  }
}
