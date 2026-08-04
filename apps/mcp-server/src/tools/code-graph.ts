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
    'Get code-index stats: how many files and symbols have been indexed. Pass project_id to scope to a specific registry project (see project_create/project_list); omit it to see the active workspace\'s legacy index.',
    {
      project_id: z.string().optional(),
    },
    async ({ project_id }) => handle(() => gwGet(`${BASE}/status`, { project_id })),
  );

  server.tool(
    'code_search_symbols',
    'Fuzzy search over indexed code symbols (functions, classes, etc.). Pass project_id to scope to a specific registry project; omit it to search the active workspace\'s legacy index.',
    {
      q: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
      type: z
        .string()
        .optional()
        .describe('Optional symbol kind filter, e.g. "function", "class".'),
      project_id: z.string().optional(),
    },
    async ({ q, limit, type, project_id }) =>
      handle(() => gwGet(`${BASE}/symbols/search`, { q, limit, type, project_id })),
  );

  server.tool(
    'code_graph_snapshot',
    'Fetch a snapshot of the code graph (CodeFile + CodeSymbol nodes). Capped by max_symbols. Pass project_id to scope to a specific registry project; omit it for the active workspace\'s legacy index.',
    {
      max_symbols: z.number().int().min(1).max(10_000).default(500),
      project_id: z.string().optional(),
    },
    async ({ max_symbols, project_id }) =>
      handle(() => gwGet(`${BASE}/graph`, { max_symbols, project_id })),
  );

  server.tool(
    'code_reindex',
    'Trigger code-graph reindex for a path (or the whole project) in the active workspace. To index a different registered project without disturbing the active one, use project_index instead.',
    {
      path: z.string().optional(),
      force: z.boolean().default(false),
    },
    async ({ path, force }) => handle(() => gwPost(`${BASE}/index`, { path, force })),
  );

  server.tool(
    'project_index',
    'Index a specific project (from the multi-project registry, see project_create/project_list) by project_id + workspace_path. Fully independent of the active workspace/dev-agent context — does not switch or disturb it. Use this to bring a newly created project into the code graph.',
    {
      project_id: z.string(),
      workspace_path: z.string(),
      force: z.boolean().default(true),
    },
    async ({ project_id, workspace_path, force }) =>
      handle(() => gwPost(`${BASE}/index-project`, { project_id, workspace_path, force })),
  );
}
