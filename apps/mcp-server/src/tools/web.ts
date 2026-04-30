/**
 * web_search — proxies to /api/v1/web-search (backed by the tool-executor's
 * DuckDuckGo-based search).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

export function registerWebTools(server: McpServer) {
  server.tool(
    'web_search',
    'Search the open web and return the top results (title + URL + snippet). Useful for grounding answers with up-to-date public information.',
    {
      q: z.string().describe('The search query.'),
      limit: z.number().int().min(1).max(20).default(5),
    },
    async ({ q, limit }) => handle(() => gwGet('/api/v1/web-search', { q, limit })),
  );
}
