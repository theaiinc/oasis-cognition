/**
 * External-agent tools — spawn and drive a third-party coding agent
 * (currently only Claude Code) via the Oasis api-gateway.
 *
 * Endpoints live under /api/v1/agents.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwPost, gwDelete } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/agents';

export function registerAgentsTools(server: McpServer) {
  server.tool(
    'agent_spawn',
    'Spin up a coding agent in a fresh git worktree to work on a goal. Preferred: pass `profile_id` (+ optional `role_id` for a role-based persona preamble). Legacy: pass `agent_type` directly. Returns the new session; poll agent_get_session or stream via the api for progress.',
    {
      goal: z.string().describe('Natural-language description of the work the agent should do.'),
      profile_id: z.string().optional().describe('Preferred. Agent profile id (from profile_list). Supplies agent_type, model, permission_mode, MCP config, and an optional system prompt preamble.'),
      role_id: z.string().optional().describe('Optional project role id (from role_list). Its description becomes a system-prompt preamble, composed before the profile preamble.'),
      agent_type: z
        .enum(['claude-code', 'cursor-cli'])
        .optional()
        .describe('Legacy. Used only when profile_id is not provided. Defaults to claude-code.'),
      permission_mode: z
        .enum(['plan', 'acceptEdits', 'bypassPermissions', 'default'])
        .optional()
        .describe('Legacy / overrides profile. Default acceptEdits.'),
      mcp_enabled: z
        .boolean()
        .optional()
        .describe('Legacy / overrides profile. Default true.'),
      project_path: z.string().optional(),
      base_branch: z.string().optional(),
      worktree_name: z.string().optional(),
    },
    async (args) => handle(() => gwPost(`${BASE}/sessions`, args)),
  );

  server.tool(
    'agent_list_sessions',
    'List all external-agent sessions, newest first.',
    {},
    async () => handle(() => gwGet(`${BASE}/sessions`)),
  );

  server.tool(
    'agent_get_session',
    'Get the full state of one external-agent session, including status, diff cache, final message.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwGet(`${BASE}/sessions/${session_id}`)),
  );

  server.tool(
    'agent_get_transcript',
    'Get the full parsed transcript of an external-agent session (all normalised events).',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwGet(`${BASE}/sessions/${session_id}/transcript`)),
  );

  server.tool(
    'agent_get_diff',
    'Get the current `git diff` for an external-agent session\'s worktree.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwGet(`${BASE}/sessions/${session_id}/diff`)),
  );

  server.tool(
    'agent_send_message',
    'Send a follow-up message to an agent session (re-spawns the child with `--resume`).',
    {
      session_id: z.string(),
      message: z.string(),
    },
    async ({ session_id, message }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/message`, { message })),
  );

  server.tool(
    'agent_merge',
    'Merge the agent\'s worktree into the base branch. Allowed only when status=awaiting_merge.',
    {
      session_id: z.string(),
      commit_message: z.string().optional(),
    },
    async ({ session_id, commit_message }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/merge`, { commit_message })),
  );

  server.tool(
    'agent_discard',
    'Discard the agent\'s worktree (throw away its changes).',
    { session_id: z.string() },
    async ({ session_id }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/discard`)),
  );

  server.tool(
    'agent_cancel',
    'Cancel a running agent session (SIGTERM the child process).',
    { session_id: z.string() },
    async ({ session_id }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/cancel`)),
  );

  server.tool(
    'agent_remove',
    'Forget an agent session completely (cancels + discards if still active).',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwDelete(`${BASE}/sessions/${session_id}`)),
  );
}
