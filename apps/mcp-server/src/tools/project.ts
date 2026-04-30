/**
 * Project tools — switch the active project and read/write project config.
 *
 * Endpoints live under /api/v1/project.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwPost } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/project';

export function registerProjectTools(server: McpServer) {
  server.tool(
    'project_get_active',
    'Get the currently active project.',
    {},
    async () => handle(() => gwGet(`${BASE}/active`)),
  );

  server.tool(
    'project_get_context',
    'Get a snapshot of the active project context (paths, recent files, indexing state).',
    {},
    async () => handle(() => gwGet(`${BASE}/context`)),
  );

  server.tool(
    'project_get_config',
    'Get the current project configuration (project_path, project_type, git_url).',
    {},
    async () => handle(() => gwGet(`${BASE}/config`)),
  );

  server.tool(
    'project_activate',
    'Activate a project by id.',
    { project_id: z.string() },
    async ({ project_id }) => handle(() => gwPost(`${BASE}/activate`, { project_id })),
  );

  server.tool(
    'project_configure',
    'Configure (or reconfigure) a project.',
    {
      project_path: z.string(),
      project_type: z.string().optional(),
      git_url: z.string().optional(),
    },
    async (args) => handle(() => gwPost(`${BASE}/configure`, args)),
  );

  server.tool(
    'project_reindex',
    'Rebuild the code graph index for the active project.',
    {},
    async () => handle(() => gwPost(`${BASE}/reindex`)),
  );

  server.tool(
    'project_get_settings',
    'Get per-project settings.',
    { project_id: z.string() },
    async ({ project_id }) => handle(() => gwGet(`${BASE}/settings/${project_id}`)),
  );

  server.tool(
    'project_save_settings',
    'Save per-project settings (free-form key/value object).',
    {
      project_id: z.string(),
      settings: z.record(z.any()),
    },
    async ({ project_id, settings }) =>
      handle(() => gwPost(`${BASE}/settings`, { project_id, settings })),
  );
}
