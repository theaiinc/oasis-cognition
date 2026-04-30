/**
 * Project-role MCP tools — CRUD over `/api/v1/project-roles`. Roles attach
 * named responsibilities (researcher / developer / analyst / designer /
 * custom) to a project, optionally bound to an agent profile.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwDelete, gwGet, gwPatch, gwPost } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/project-roles';

const KindSchema = z.enum(['researcher', 'developer', 'data_analyst', 'designer', 'custom']);

export function registerProjectRoleTools(server: McpServer) {
  server.tool(
    'role_list',
    'List roles for a project. Each role carries a job description (injected as a system-prompt preamble when an agent spawns through it) and optionally an agent_profile_id binding.',
    { project_id: z.string() },
    async ({ project_id }) => handle(() => gwGet(BASE, { project_id })),
  );

  server.tool(
    'role_get',
    'Fetch one project role by id.',
    { role_id: z.string() },
    async ({ role_id }) => handle(() => gwGet(`${BASE}/${role_id}`)),
  );

  server.tool(
    'role_create',
    'Create a project role. For preset `kind`s the default name+description are used when fields are omitted; custom roles require a non-empty description.',
    {
      project_id: z.string(),
      name: z.string().optional(),
      kind: KindSchema,
      description: z.string().optional(),
      agent_profile_id: z.string().optional(),
    },
    async (dto) => handle(() => gwPost(BASE, dto)),
  );

  server.tool(
    'role_update',
    'Patch a role — rename, edit description, rebind to a different agent profile.',
    {
      role_id: z.string(),
      name: z.string().optional(),
      kind: KindSchema.optional(),
      description: z.string().optional(),
      agent_profile_id: z.string().optional(),
    },
    async ({ role_id, ...patch }) => handle(() => gwPatch(`${BASE}/${role_id}`, patch)),
  );

  server.tool(
    'role_delete',
    'Delete a project role.',
    { role_id: z.string() },
    async ({ role_id }) => handle(() => gwDelete(`${BASE}/${role_id}`)),
  );

  server.tool(
    'role_seed_presets',
    'Create the four preset roles (researcher, developer, data_analyst, designer) for a project. Idempotent — skips kinds that already exist.',
    { project_id: z.string() },
    async ({ project_id }) => handle(() => gwPost(`${BASE}/seed-presets?project_id=${encodeURIComponent(project_id)}`, {})),
  );
}
