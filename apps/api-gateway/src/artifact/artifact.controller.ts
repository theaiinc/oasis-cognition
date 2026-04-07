import {
  Controller, Get, Post, Delete, Patch, Body, Param, Query, Res, Req,
  Logger, HttpException, HttpStatus,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import axios from 'axios';
import * as FormData from 'form-data';
import type { Request, Response } from 'express';

const ARTIFACT_URL = process.env.ARTIFACT_SERVICE_URL || 'http://localhost:8012';
const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';
const DIARIZATION_URL = process.env.DIARIZATION_SERVICE_URL || 'http://host.docker.internal:8097';

@Controller('artifacts')
export class ArtifactController {
  private readonly logger = new Logger(ArtifactController.name);

  // ── Upload ──────────────────────────────────────────────────────────

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { language?: string; project_id?: string },
  ) {
    if (!file) {
      throw new HttpException('File is required', HttpStatus.BAD_REQUEST);
    }
    try {
      const form = new FormData();
      form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
      if (body.language) form.append('language', body.language);
      if (body.project_id) form.append('project_id', body.project_id);

      const res = await axios.post(`${ARTIFACT_URL}/internal/artifacts/upload`, form, {
        headers: form.getHeaders(),
        maxContentLength: 500 * 1024 * 1024,
        maxBodyLength: 500 * 1024 * 1024,
      });
      return res.data;
    } catch (err: any) {
      this.logger.error('Upload failed', err.message);
      throw new HttpException(
        { error: 'Upload failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('youtube')
  async uploadYoutube(@Body() body: { url: string; language?: string; project_id?: string }) {
    if (!body.url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }
    try {
      const form = new FormData();
      form.append('url', body.url);
      if (body.language) form.append('language', body.language);
      if (body.project_id) form.append('project_id', body.project_id);

      const res = await axios.post(`${ARTIFACT_URL}/internal/artifacts/youtube`, form, {
        headers: form.getHeaders(),
        timeout: 600000,
      });
      return res.data;
    } catch (err: any) {
      this.logger.error('YouTube download failed', err.message);
      throw new HttpException(
        { error: 'YouTube download failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  @Get()
  async list(@Query('project_id') projectId?: string) {
    try {
      const res = await axios.get(`${ARTIFACT_URL}/internal/artifacts`, {
        params: projectId ? { project_id: projectId } : {},
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'List artifacts failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('events')
  async events(@Req() req: Request, @Res() res: Response) {
    // Proxy SSE stream from artifact-service
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    try {
      const upstream = await axios.get(`${ARTIFACT_URL}/internal/artifacts/events`, {
        responseType: 'stream',
        timeout: 0, // no timeout for SSE
      });

      // Pipe upstream SSE data to client
      upstream.data.on('data', (chunk: Buffer) => {
        res.write(chunk);
      });

      upstream.data.on('end', () => {
        res.end();
      });

      upstream.data.on('error', (err: Error) => {
        this.logger.warn('SSE upstream error: ' + err.message);
        res.end();
      });

      // Clean up when client disconnects
      req.on('close', () => {
        upstream.data.destroy();
      });
    } catch (err: any) {
      this.logger.warn('SSE connection failed: ' + err.message);
      res.write(`data: ${JSON.stringify({ event: 'error', message: 'Connection failed' })}\n\n`);
      res.end();
    }
  }

  @Get('queue')
  async queueStatus() {
    try {
      const res = await axios.get(`${ARTIFACT_URL}/internal/artifacts/queue`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Queue status failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('search')
  async search(
    @Query('q') q: string,
    @Query('limit') limit: string = '10',
    @Query('project_id') projectId?: string,
  ) {
    if (!q) throw new HttpException('"q" is required', HttpStatus.BAD_REQUEST);
    try {
      const res = await axios.get(`${ARTIFACT_URL}/internal/artifacts/search`, {
        params: { q, limit: parseInt(limit, 10), ...(projectId ? { project_id: projectId } : {}) },
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Search failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':artifact_id')
  async get(@Param('artifact_id') artifactId: string) {
    try {
      const res = await axios.get(`${ARTIFACT_URL}/internal/artifacts/${artifactId}`);
      return res.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        throw new HttpException('Artifact not found', HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        { error: 'Get artifact failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':artifact_id/download')
  async download(@Param('artifact_id') artifactId: string, @Res() res: Response) {
    try {
      const upstream = await axios.get(
        `${ARTIFACT_URL}/internal/artifacts/${artifactId}/file`,
        { responseType: 'stream' },
      );
      res.set({
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
        'Content-Disposition': upstream.headers['content-disposition'] || 'inline',
        ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}),
      });
      upstream.data.pipe(res);
    } catch (err: any) {
      if (err.response?.status === 404) {
        throw new HttpException('File not found', HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        { error: 'Download failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':artifact_id')
  async delete(@Param('artifact_id') artifactId: string) {
    try {
      const res = await axios.delete(`${ARTIFACT_URL}/internal/artifacts/${artifactId}`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Delete artifact failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':artifact_id/summarize')
  async summarize(@Param('artifact_id') artifactId: string, @Body() body?: { language?: string; instructions?: string }) {
    try {
      const res = await axios.post(`${ARTIFACT_URL}/internal/artifacts/${artifactId}/summarize`, body || {}, {
        timeout: 120000,
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Summarize failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':artifact_id/process')
  async process(@Param('artifact_id') artifactId: string) {
    try {
      const res = await axios.post(`${ARTIFACT_URL}/internal/artifacts/${artifactId}/process`, {}, {
        timeout: 600000,
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Processing failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

// ── Projects controller (proxies to memory-service) ──────────────────

@Controller('projects')
export class ProjectsController {
  private readonly logger = new Logger(ProjectsController.name);

  @Post()
  async create(@Body() body: { name: string; description?: string }) {
    if (!body.name) throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/projects`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Create project failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  async list() {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/projects`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'List projects failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':project_id')
  async get(@Param('project_id') projectId: string) {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/projects/${projectId}`);
      return res.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        throw new HttpException('Project not found', HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        { error: 'Get project failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch(':project_id')
  async update(@Param('project_id') projectId: string, @Body() body: { name?: string; description?: string; project_path?: string }) {
    try {
      const res = await axios.patch(`${MEMORY_URL}/internal/memory/projects/${projectId}`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Update project failed', detail: err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':project_id')
  async delete(@Param('project_id') projectId: string) {
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/projects/${projectId}`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Delete project failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Linking: artifacts ───────────────────────────────────────────────

  @Post(':project_id/artifacts')
  async linkArtifact(@Param('project_id') projectId: string, @Body() body: { artifact_id: string }) {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/projects/${projectId}/artifacts`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Link artifact failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':project_id/artifacts/:artifact_id')
  async unlinkArtifact(@Param('project_id') projectId: string, @Param('artifact_id') artifactId: string) {
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/projects/${projectId}/artifacts/${artifactId}`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Unlink artifact failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Linking: chats ──────────────────────────────────────────────────

  @Post(':project_id/chats')
  async linkChat(@Param('project_id') projectId: string, @Body() body: { session_id: string }) {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/projects/${projectId}/chats`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Link chat failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':project_id/chats/:session_id')
  async unlinkChat(@Param('project_id') projectId: string, @Param('session_id') sessionId: string) {
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/projects/${projectId}/chats/${sessionId}`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Unlink chat failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':project_id/chats')
  async getChats(@Param('project_id') projectId: string) {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/projects/${projectId}/chats`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Get project chats failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Linking: repos ──────────────────────────────────────────────────

  @Post('repos')
  async createRepo(@Body() body: { git_url: string; project_path?: string; name?: string }) {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/repos`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Create repo failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':project_id/repos')
  async linkRepo(@Param('project_id') projectId: string, @Body() body: { repo_id: string }) {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/projects/${projectId}/repos`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Link repo failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':project_id/repos/:repo_id')
  async unlinkRepo(@Param('project_id') projectId: string, @Param('repo_id') repoId: string) {
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/projects/${projectId}/repos/${repoId}`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Unlink repo failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Project-scoped rules ────────────────────────────────────────────

  @Get(':project_id/rules')
  async getRules(@Param('project_id') projectId: string, @Query('keywords') keywords?: string) {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/projects/${projectId}/rules`, {
        params: keywords ? { keywords } : {},
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Get project rules failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('rules/scope')
  async scopeRule(@Body() body: { rule_id: string; project_id: string }) {
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/rules/scope`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Scope rule failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

// ── Speakers controller (proxies to memory-service) ─────────────────

@Controller('speakers')
export class SpeakersController {
  private readonly logger = new Logger(SpeakersController.name);

  @Post()
  async create(@Body() body: { name: string; embedding: number[]; source_artifact_id?: string }) {
    if (!body.name) throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/speakers`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Create speaker failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  async list() {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/speakers`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'List speakers failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':speaker_id')
  async get(@Param('speaker_id') speakerId: string) {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/speakers/${speakerId}`);
      return res.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        throw new HttpException('Speaker not found', HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        { error: 'Get speaker failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch(':speaker_id')
  async update(@Param('speaker_id') speakerId: string, @Body() body: { name?: string; embedding?: number[] }) {
    try {
      const res = await axios.patch(`${MEMORY_URL}/internal/memory/speakers/${speakerId}`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Update speaker failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':speaker_id')
  async delete(@Param('speaker_id') speakerId: string) {
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/speakers/${speakerId}`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Delete speaker failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('identify')
  async identify(@Body() body: { embedding: number[]; threshold?: number }) {
    if (!body.embedding) throw new HttpException('embedding is required', HttpStatus.BAD_REQUEST);
    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/speakers/identify`, body);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Identify speaker failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('enroll')
  async enroll(@Body() body: { artifact_id: string; name: string }) {
    if (!body.artifact_id) throw new HttpException('artifact_id is required', HttpStatus.BAD_REQUEST);
    if (!body.name) throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    try {
      // 1. Fetch the audio file from artifact-service
      const fileRes = await axios.get(
        `${ARTIFACT_URL}/internal/artifacts/${body.artifact_id}/file`,
        { responseType: 'arraybuffer' },
      );

      // 2. Send to diarization service for voiceprint extraction
      // Derive extension from content-type so diarization service can detect format
      const ct = fileRes.headers['content-type'] || 'audio/mpeg';
      const extMap: Record<string, string> = {
        'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
        'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg',
        'audio/flac': '.flac', 'audio/aac': '.aac', 'audio/webm': '.webm',
      };
      const ext = extMap[ct] || '.audio';
      const form = new FormData();
      form.append('file', fileRes.data, {
        filename: `audio${ext}`,
        contentType: ct,
      });
      const vpRes = await axios.post(`${DIARIZATION_URL}/extract-voiceprint`, form, {
        headers: form.getHeaders(),
        timeout: 120000,
      });
      const embedding = vpRes.data.embedding;

      // 3. Create speaker profile in memory-service
      const speakerRes = await axios.post(`${MEMORY_URL}/internal/memory/speakers`, {
        name: body.name,
        embedding,
        source_artifact_id: body.artifact_id,
      });
      return speakerRes.data;
    } catch (err: any) {
      this.logger.error('Enroll speaker failed', err.message);
      throw new HttpException(
        { error: 'Enroll speaker failed', detail: err.response?.data || err.message },
        err.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
