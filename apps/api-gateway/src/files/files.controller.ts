import { Controller, Get, Query, Res, HttpException, HttpStatus, Logger } from '@nestjs/common';
import axios from 'axios';
import type { Response } from 'express';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';

@Controller('files')
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  /** Returns text content as JSON. Falls back to error info for binary files. */
  @Get('text')
  async readText(
    @Query('path') path: string,
    @Query('worktree_id') worktreeId?: string,
  ) {
    if (!path) throw new HttpException('"path" is required', HttpStatus.BAD_REQUEST);
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/file/read`, {
        params: { path, ...(worktreeId ? { worktree_id: worktreeId } : {}) },
        timeout: 10000,
      });
      return res.data;
    } catch (err: any) {
      const status = err.response?.status || HttpStatus.SERVICE_UNAVAILABLE;
      const detail = err.response?.data?.detail || err.message || 'Failed to read file';
      throw new HttpException({ error: detail }, status);
    }
  }

  /** Streams the raw file with proper Content-Type. Used for images / PDFs. */
  @Get()
  async readBinary(
    @Query('path') path: string,
    @Res() res: Response,
    @Query('worktree_id') worktreeId?: string,
  ) {
    if (!path) throw new HttpException('"path" is required', HttpStatus.BAD_REQUEST);
    try {
      const upstream = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/file/binary`, {
        params: { path, ...(worktreeId ? { worktree_id: worktreeId } : {}) },
        responseType: 'stream',
        timeout: 30000,
      });
      res.set({
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
        ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}),
        'Cache-Control': 'no-store',
      });
      upstream.data.pipe(res);
    } catch (err: any) {
      const status = err.response?.status || HttpStatus.SERVICE_UNAVAILABLE;
      const detail = err.response?.data?.detail || err.message || 'Failed to read file';
      throw new HttpException({ error: detail }, status);
    }
  }
}
