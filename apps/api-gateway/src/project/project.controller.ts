import { Controller, Post, Get, Delete, Param, Body, Query, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { RedisEventService } from '../events/redis-event.service';
import { CoordinatorService } from '../coordinator/coordinator.service';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const MEMORY_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:8004';

@Controller('project')
export class ProjectController {
  private readonly logger = new Logger(ProjectController.name);

  constructor(
    private readonly events: RedisEventService,
    private readonly coordinator: CoordinatorService,
  ) {}

  @Get('config')
  async getConfig() {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/project/config`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return { configured: false };
      }
      this.logger.warn(`Dev-agent unavailable: ${err.message}`);
      throw new HttpException('Dev-agent is not running', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Get('operations')
  async operations(@Query('project_id') projectId: string, @Query('limit') limit = '100') {
    if (!projectId?.trim()) {
      throw new HttpException('project_id is required', HttpStatus.BAD_REQUEST);
    }
    const project = projectId.trim();
    const boundedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
    return {
      project_id: project,
      active_sessions: await this.events.getActiveSessions(project),
      events: await this.events.getProjectEvents(project, boundedLimit),
      jobs: await this.coordinator.listJobs(undefined, project),
    };
  }

  @Post('configure')
  async configure(@Body() body: { project_path: string; project_type: string; git_url?: string }) {
    this.logger.log(`Configuring project: ${body.project_path}`);
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/project/configure`, body, { timeout: 60000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to configure project',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('reindex')
  async reindex() {
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/project/reindex`, {}, { timeout: 60000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to reindex project',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('context')
  async getContext() {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/project/context`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to get project context',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Project registry (multi-project, memory-service/Neo4j-backed) ──────
  // Distinct from configure/activate above: those mutate the single active
  // dev-agent working context. These just create/list/remove registry
  // entries in memory-service and never touch the active project.

  @Post('create')
  async create(@Body() body: { name: string; description?: string; project_path?: string }) {
    if (!body?.name?.trim()) {
      throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    }
    this.logger.log(`Creating project registry entry: ${body.name}`);
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/projects`, body, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to create project',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('list')
  async list() {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/projects`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to list projects',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('registry/:project_id')
  async removeFromRegistry(@Param('project_id') projectId: string) {
    this.logger.log(`Removing project registry entry: ${projectId}`);
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/projects/${projectId}`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to delete project',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Per-project settings & activation ──────────────────────────────────

  @Post('activate')
  async activate(@Body() body: { project_id: string | null }) {
    this.logger.log(`Activating project: ${body.project_id}`);
    try {
      // If activating a project, look up its project_path from the artifact service (Neo4j)
      // and pass it to the dev-agent so it can persist it even if local settings are empty.
      let projectPath: string | undefined;
      if (body.project_id) {
        try {
          const projRes = await axios.get(`${MEMORY_URL}/internal/memory/projects/${body.project_id}`, { timeout: 5000 });
          projectPath = projRes.data?.project_path;
          if (projectPath) {
            this.logger.log(`Project ${body.project_id} has project_path=${projectPath} in Neo4j`);
          }
        } catch {
          // artifact service may not have the project — continue without it
        }
      }

      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/project/activate`, {
        ...body,
        project_path: projectPath, // pass along so dev-agent can save it locally
      }, { timeout: 15000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to activate project',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('active')
  async getActive() {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/project/active`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Dev-agent unavailable: ${err.message}`);
      throw new HttpException('Dev-agent is not running', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Get('settings/:project_id')
  async getSettings(@Param('project_id') projectId: string) {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/project/settings/${projectId}`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to get project settings',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('settings')
  async saveSettings(@Body() body: { project_id: string; settings: Record<string, any> }) {
    this.logger.log(`Saving settings for project: ${body.project_id}`);
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/project/settings`, body, { timeout: 15000 });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        err.response?.data || 'Failed to save project settings',
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
