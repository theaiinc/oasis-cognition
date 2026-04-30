/**
 * Agent profile MCP tools — CRUD over `/api/v1/agent-profiles`. Lets chat /
 * voice clients define, list, and edit reusable agent configurations.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwDelete, gwGet, gwPatch, gwPost } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/agent-profiles';

const ProfileTypeSchema = z.enum(['internal', 'claude-code', 'cursor-cli']);
const PermissionModeSchema = z.enum(['plan', 'acceptEdits', 'bypassPermissions', 'default']);
const ProfileConfigSchema = z.object({
  model: z.string().optional(),
  provider: z.enum(['ollama', 'openai', 'anthropic']).optional(),
  permission_mode: PermissionModeSchema.optional(),
  mcp_enabled: z.boolean().optional(),
  system_prompt_preamble: z.string().optional(),
  extra_args: z.array(z.string()).optional(),
}).optional();

export function registerAgentProfileTools(server: McpServer) {
  server.tool(
    'profile_list',
    'List all saved agent profiles (reusable agent configurations: type, model, permission mode, system-prompt preamble, etc).',
    {},
    async () => handle(() => gwGet(BASE)),
  );

  server.tool(
    'profile_get',
    'Fetch one agent profile by id.',
    { profile_id: z.string() },
    async ({ profile_id }) => handle(() => gwGet(`${BASE}/${profile_id}`)),
  );

  server.tool(
    'profile_create',
    'Create a new agent profile. `agent_type` picks the underlying implementation; `config.model` chooses the LLM/CLI model; `config.system_prompt_preamble` is prepended to every spawn.',
    {
      name: z.string(),
      description: z.string().optional(),
      agent_type: ProfileTypeSchema,
      config: ProfileConfigSchema,
    },
    async (dto) => handle(() => gwPost(BASE, dto)),
  );

  server.tool(
    'profile_update',
    'Patch a profile in place. `config` fields are shallow-merged.',
    {
      profile_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      agent_type: ProfileTypeSchema.optional(),
      config: ProfileConfigSchema,
    },
    async ({ profile_id, ...patch }) => handle(() => gwPatch(`${BASE}/${profile_id}`, patch)),
  );

  server.tool(
    'profile_delete',
    'Delete an agent profile. Any project roles bound to it are left with an empty binding.',
    { profile_id: z.string() },
    async ({ profile_id }) => handle(() => gwDelete(`${BASE}/${profile_id}`)),
  );
}
