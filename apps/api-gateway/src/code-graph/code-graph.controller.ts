import { Controller, Get, Post, Query, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

const CODE_INDEXER_URL = process.env.CODE_INDEXER_URL || 'http://localhost:8010';

@Controller('code-graph')
export class CodeGraphController {
  private readonly logger = new Logger(CodeGraphController.name);

  /** Index status — how many files and symbols are in the graph. */
  @Get('status')
  async getStatus(@Query('project_id') projectId?: string) {
    try {
      const res = await axios.get(`${CODE_INDEXER_URL}/index/status`, {
        params: { project_id: projectId },
        timeout: 8000,
      });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Code-indexer unavailable: ${err.message}`);
      throw new HttpException(
        { error: 'code-indexer unavailable', detail: err.message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** Full graph — all CodeFile + CodeSymbol nodes and relationships. */
  @Get('graph')
  async getFullGraph(@Query('max_symbols') maxSymbols?: string, @Query('project_id') projectId?: string) {
    const limit = maxSymbols ? parseInt(maxSymbols, 10) : 300;
    try {
      const res = await axios.get(`${CODE_INDEXER_URL}/graph`, {
        params: { max_symbols: limit, project_id: projectId },
        timeout: 30000,
      });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Code graph fetch failed: ${err.message}`);
      throw new HttpException(
        { error: 'Failed to fetch code graph', detail: err.message },
        err.response?.status || HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** Symbol search — fuzzy search by name. */
  @Get('symbols/search')
  async searchSymbols(
    @Query('q') q: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('project_id') projectId?: string,
  ) {
    try {
      const res = await axios.get(`${CODE_INDEXER_URL}/symbols/search`, {
        params: { q, type, limit: limit ? parseInt(limit, 10) : 20, project_id: projectId },
        timeout: 8000,
      });
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Symbol search failed: ${err.message}`);
      throw new HttpException(
        { error: 'Symbol search failed', detail: err.message },
        err.response?.status || HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** Trigger a full workspace reindex. */
  @Post('index')
  async triggerIndex(@Body() body: { path?: string; force?: boolean }) {
    try {
      const res = await axios.post(
        body.path ? `${CODE_INDEXER_URL}/index` : `${CODE_INDEXER_URL}/index/full`,
        body.path ? { path: body.path, force: body.force ?? false } : {},
        { timeout: 120000 },
      );
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Index trigger failed: ${err.message}`);
      throw new HttpException(
        { error: 'Indexing failed', detail: err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Index a specific project's workspace, scoped by project_id.
   * Independent of the active workspace — does not disturb it.
   */
  @Post('index-project')
  async indexProject(@Body() body: { project_id: string; workspace_path: string; force?: boolean }) {
    if (!body?.project_id || !body?.workspace_path) {
      throw new HttpException('project_id and workspace_path are required', HttpStatus.BAD_REQUEST);
    }
    this.logger.log(`Indexing project ${body.project_id} at ${body.workspace_path}`);
    try {
      const res = await axios.post(
        `${CODE_INDEXER_URL}/index/project`,
        { project_id: body.project_id, workspace_path: body.workspace_path, force: body.force ?? true },
        { timeout: 120000 },
      );
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Project index failed: ${err.message}`);
      throw new HttpException(
        { error: 'Project indexing failed', detail: err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
