import {
  Body, Controller, Delete, Get, HttpException, HttpStatus,
  Param, Patch, Post, Query,
} from '@nestjs/common';
import { ProjectRolesService } from './project-roles.service';
import type { CreateProjectRoleDto, UpdateProjectRoleDto } from './project-roles.types';

@Controller('project-roles')
export class ProjectRolesController {
  constructor(private readonly service: ProjectRolesService) {}

  @Get()
  list(@Query('project_id') projectId: string) {
    if (!projectId) throw new HttpException('project_id is required', HttpStatus.BAD_REQUEST);
    return this.service.listByProject(projectId);
  }

  @Get(':id')
  get(@Param('id') id: string) { return this.service.get(id); }

  @Post()
  create(@Body() dto: CreateProjectRoleDto) { return this.service.create(dto); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() patch: UpdateProjectRoleDto) {
    return this.service.update(id, patch);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { deleted: true };
  }

  @Post('seed-presets')
  seed(@Query('project_id') projectId: string) {
    if (!projectId) throw new HttpException('project_id is required', HttpStatus.BAD_REQUEST);
    return this.service.seedPresets(projectId);
  }
}
