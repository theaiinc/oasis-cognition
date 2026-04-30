/**
 * Memory tools — semantic recall and rule inspection.
 *
 * Endpoints live under /api/v1/memory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwDelete } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/memory';

export function registerMemoryTools(server: McpServer) {
  server.tool(
    'memory_query',
    'Semantic search over Oasis memory (facts, observations, past conclusions). Returns the most relevant entries.',
    {
      q: z.string().describe('Natural-language query.'),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ q, limit }) => handle(() => gwGet(`${BASE}/query`, { q, limit })),
  );

  server.tool(
    'memory_list_rules',
    'List all rules in the logic engine (condition → conclusion with confidence).',
    {},
    async () => handle(() => gwGet(`${BASE}/rules`)),
  );

  server.tool(
    'memory_rules_graph',
    'Return the rule-dependency graph as nodes + edges, useful for visualisation.',
    {},
    async () => handle(() => gwGet(`${BASE}/rules/graph`)),
  );

  server.tool(
    'memory_delete_rule',
    'Delete a rule from the logic engine by id.',
    { rule_id: z.string() },
    async ({ rule_id }) => handle(() => gwDelete(`${BASE}/rules`, { rule_id })),
  );
}
