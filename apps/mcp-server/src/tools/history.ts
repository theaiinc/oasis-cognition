/**
 * History tools — list and manage Oasis chat sessions.
 *
 * Endpoints live under /api/v1/history.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwDelete } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/history';

export function registerHistoryTools(server: McpServer) {
  server.tool(
    'history_list_sessions',
    'List all chat sessions (most recent first).',
    {},
    async () => handle(() => gwGet(`${BASE}/sessions`)),
  );

  server.tool(
    'history_get_messages',
    'Get all messages in a chat session.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwGet(`${BASE}/messages`, { session_id })),
  );

  server.tool(
    'history_delete_session',
    'Delete a chat session and its messages.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwDelete(`${BASE}/session`, { session_id })),
  );
}
