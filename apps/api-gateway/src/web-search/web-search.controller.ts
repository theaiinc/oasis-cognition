/**
 * Web-search proxy endpoint.
 *
 * Forwards to the tool-executor's `web_search` tool which itself uses a
 * DuckDuckGo-backed search (see services/tool-executor). This is a thin
 * pass-through so the MCP server + external agents get a first-class
 * `web_search` capability without having to reach into the tool-executor
 * directly.
 */

import { Controller, Get, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import axios from 'axios';

const TOOL_EXECUTOR_URL = process.env.TOOL_EXECUTOR_URL || 'http://localhost:8007';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

@Controller('web-search')
export class WebSearchController {
  private readonly logger = new Logger(WebSearchController.name);

  @Get()
  async search(
    @Query('q') q: string,
    @Query('limit') limitStr?: string,
  ): Promise<{ query: string; results: WebSearchResult[]; count: number }> {
    const query = (q || '').trim();
    if (!query) throw new HttpException('q is required', HttpStatus.BAD_REQUEST);
    const limit = Math.min(20, Math.max(1, parseInt(limitStr || '5', 10) || 5));

    try {
      const res = await axios.post(
        `${TOOL_EXECUTOR_URL}/internal/tool/execute`,
        {
          tool: 'web_search',
          // tool-executor repurposes `command` for the search query.
          command: query,
        },
        { timeout: 30_000 },
      );
      const data = res.data;
      if (!data?.success) {
        throw new HttpException(data?.output || 'web_search failed', HttpStatus.BAD_GATEWAY);
      }
      const rawResults: WebSearchResult[] = Array.isArray(data.results) ? data.results : [];
      const results = rawResults.slice(0, limit);
      return { query, results, count: results.length };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`web-search failed: ${err.message}`);
      throw new HttpException(
        `web_search unavailable: ${err?.message || 'unknown error'}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
