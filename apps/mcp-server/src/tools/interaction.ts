/**
 * Interaction tool — delegate a turn to the Oasis reasoning pipeline.
 *
 * The gateway endpoint /api/v1/interaction streams NDJSON events. For an MCP
 * tool we block until completion and return just the final assistant response
 * plus a small envelope. Long-running questions (up to 90s) are supported.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwInteract } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

export function registerInteractionTools(server: McpServer) {
  server.tool(
    'oasis_ask',
    'Send a message to the Oasis reasoning pipeline and get the final response. Use this to delegate planning, recall, or code questions to Oasis itself instead of answering directly.',
    {
      message: z.string().describe('The user message / question to send to Oasis.'),
      session_id: z
        .string()
        .optional()
        .describe('Optional existing Oasis chat session to continue. Omit to start a new one.'),
      system_override: z
        .string()
        .optional()
        .describe('Optional system-prompt override for this turn only.'),
      max_tokens: z.number().int().optional(),
      timeout_ms: z
        .number()
        .int()
        .default(90_000)
        .describe('Max time to wait for a response, in ms.'),
    },
    async ({ message, session_id, system_override, max_tokens, timeout_ms }) =>
      handle(() => {
        const context: Record<string, any> = {};
        if (system_override) context.system_override = system_override;
        if (typeof max_tokens === 'number') context.max_tokens = max_tokens;
        return gwInteract(message, session_id, Object.keys(context).length ? context : undefined, timeout_ms);
      }),
  );
}
