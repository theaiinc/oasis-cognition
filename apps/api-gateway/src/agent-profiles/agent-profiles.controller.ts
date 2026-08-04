import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AgentProfilesService } from './agent-profiles.service';
import type { CreateAgentProfileDto, UpdateAgentProfileDto } from './agent-profiles.types';

@Controller('agent-profiles')
export class AgentProfilesController {
  constructor(private readonly service: AgentProfilesService) {}

  private safe(profile: any) {
    const config = { ...(profile.config || {}) };
    for (const key of ['openai_api_key', 'anthropic_api_key']) {
      if (config[key]) {
        config[key] = '';
        config[`${key}_configured`] = true;
      }
    }
    return { ...profile, config };
  }

  @Get()
  async list() { return (await this.service.list()).map(p => this.safe(p)); }

  @Get(':id')
  async get(@Param('id') id: string) { return this.safe(await this.service.get(id)); }

  @Post()
  async create(@Body() dto: CreateAgentProfileDto) {
    return this.safe(await this.service.create(dto));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() patch: UpdateAgentProfileDto) {
    return this.safe(await this.service.update(id, patch));
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { deleted: true };
  }
}
