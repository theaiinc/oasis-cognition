import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AgentProfilesService } from './agent-profiles.service';
import type { CreateAgentProfileDto, UpdateAgentProfileDto } from './agent-profiles.types';

@Controller('agent-profiles')
export class AgentProfilesController {
  constructor(private readonly service: AgentProfilesService) {}

  @Get()
  list() { return this.service.list(); }

  @Get(':id')
  get(@Param('id') id: string) { return this.service.get(id); }

  @Post()
  create(@Body() dto: CreateAgentProfileDto) { return this.service.create(dto); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() patch: UpdateAgentProfileDto) {
    return this.service.update(id, patch);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { deleted: true };
  }
}
