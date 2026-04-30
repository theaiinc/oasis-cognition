/**
 * Code-graph tools — search indexed symbols and inspect graph status.
 *
 * Endpoints live under /api/v1/code-graph.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwPost } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/code-graph';

export function registerCodeGraphTools(server: McpServer) {
  server.tool(
    'code_graph_status',
    'Get code-index stats: how many files and symbols have been indexed.',
    {},
    async () => handle(() => gwGet(`${BASE}/status`)),
  );

  server.tool(
    'code_search_symbols',
    'Fuzzy search over indexed code symbols (functions, classes, etc.).',
    {
      q: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
      type: z
        .string()
        .optional()
        .describe('Optional symbol kind filter, e.g. "function", "class".'),
    },
    async ({ q, limit, type }) =>
      handle(() => gwGet(`${BASE}/symbols/search`, { q, limit, type })),
  );

  server.tool(
    'code_graph_snapshot',
    'Fetch a snapshot of the code graph (CodeFile + CodeSymbol nodes). Capped by max_symbols.',
    {
      max_symbols: z.number().int().min(1).max(10_000).default(500),
    },
    async ({ max_symbols }) =>
      handle(() => gwGet(`${BASE}/graph`, { max_symbols })),
  );

  server.tool(
    'code_reindex',
    'Trigger code-graph reindex for a path (or the whole project).',
    {
      path: z.string().optional(),
      force: z.boolean().default(false),
    },
    async ({ path, force }) => handle(() => gwPost(`${BASE}/index`, { path, force })),
  );
}
