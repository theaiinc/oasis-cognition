import { Body, Controller, Delete, Get, Param, Patch, Post, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { MissionsService } from './missions.service';
import type { CreateMissionDto, UpdateMissionDto } from './missions.types';

@Controller('missions')
export class MissionsController {
  private readonly logger = new Logger(MissionsController.name);
  constructor(private readonly missions: MissionsService) {}

  @Get()
  async list() {
    return { missions: await this.missions.list() };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const m = await this.missions.get(id);
    if (!m) throw new HttpException('mission not found', HttpStatus.NOT_FOUND);
    return m;
  }

  @Post()
  async create(@Body() dto: CreateMissionDto) {
    return this.missions.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateMissionDto) {
    return this.missions.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.missions.remove(id);
    return { ok: true };
  }

  @Post(':id/pause')
  async pause(@Param('id') id: string) {
    return this.missions.pause(id);
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    return this.missions.resume(id);
  }

  @Post(':id/run')
  async runOnce(@Param('id') id: string) {
    return this.missions.runOnce(id);
  }
}
