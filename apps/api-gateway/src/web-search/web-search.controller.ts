/**
 * Web-search endpoint, so the MCP server and external agents get a first-class
 * `web_search` capability. The provider is OASIS_WEB_SEARCH_PROVIDER
 * (web-search.provider.ts); DuckDuckGo through the tool-executor by default.
 */

import { Controller, Get, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { clampLimit, searchWeb, WebSearchError, type WebSearchResult } from './web-search.provider';

export type { WebSearchResult } from './web-search.provider';

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
    try {
      const { results } = await searchWeb(query, { limit: clampLimit(limitStr) });
      return { query, results, count: results.length };
    } catch (err: any) {
      this.logger.error(`web-search failed: ${err.message}`);
      const detail = err instanceof WebSearchError ? err.message : err?.message || 'unknown error';
      throw new HttpException(`web_search unavailable: ${detail}`, HttpStatus.BAD_GATEWAY);
    }
  }
}
