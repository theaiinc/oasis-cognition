import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { MissionsService } from './missions.service';
import { bulkFilter, bulkTargets } from './missions-bulk';
import type { BulkMissionsDto, BulkMissionsResult, CreateMissionDto, Mission, UpdateMissionDto } from './missions.types';

@Controller('missions')
export class MissionsController {
  private readonly logger = new Logger(MissionsController.name);
  constructor(private readonly missions: MissionsService) {}

  @Get()
  async list(@Query('project_id') projectId?: string) {
    return { missions: await this.missions.list(projectId?.trim() || undefined) };
  }

  /** Pause every mission (optionally only one project's or one role's). */
  @Post('pause-all')
  async pauseAll(@Body() body: BulkMissionsDto) {
    return this.bulk(body, 'pause');
  }

  /** Resume every paused mission (same filters as pause-all). */
  @Post('resume-all')
  async resumeAll(@Body() body: BulkMissionsDto) {
    return this.bulk(body, 'resume');
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

  private async bulk(body: BulkMissionsDto | undefined, op: 'pause' | 'resume'): Promise<BulkMissionsResult> {
    const { inScope, targets } = bulkTargets(await this.missions.list(), bulkFilter(body), op);
    const changed: Mission[] = [];
    for (const m of targets) {
      changed.push(op === 'pause' ? await this.missions.pause(m.mission_id) : await this.missions.resume(m.mission_id));
    }
    this.logger.log(`${op}-all: ${changed.length} changed, ${inScope.length - targets.length} unchanged`);
    return { changed, unchanged: inScope.length - targets.length };
  }
}
