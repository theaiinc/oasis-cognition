/**
 * Artifact tools — search, inspect, and process indexed files/documents.
 *
 * Upload (multipart) is intentionally NOT exposed here; voice assistants should
 * hand off file-upload UX to the user. `artifact_from_youtube` is kept because
 * it needs only a URL and is genuinely useful for voice.
 *
 * Endpoints live under /api/v1/artifacts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwPost, gwDelete } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/artifacts';

export function registerArtifactTools(server: McpServer) {
  server.tool(
    'artifact_search',
    'Full-text / semantic search over artifacts. Returns top matches with snippets.',
    {
      q: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
      project_id: z.string().optional(),
    },
    async ({ q, limit, project_id }) =>
      handle(() => gwGet(`${BASE}/search`, { q, limit, project_id })),
  );

  server.tool(
    'artifact_list',
    'List all artifacts, optionally filtered by project.',
    {
      project_id: z.string().optional(),
    },
    async ({ project_id }) => handle(() => gwGet(BASE, { project_id })),
  );

  server.tool(
    'artifact_get',
    'Get metadata for a single artifact by id.',
    { artifact_id: z.string() },
    async ({ artifact_id }) => handle(() => gwGet(`${BASE}/${artifact_id}`)),
  );

  server.tool(
    'artifact_summarize',
    'Ask Oasis to summarise an artifact. The summary is written back to the artifact and returned.',
    {
      artifact_id: z.string(),
      language: z.string().optional().describe('BCP-47 code, e.g. "en", "vi".'),
      instructions: z.string().optional(),
    },
    async ({ artifact_id, language, instructions }) =>
      handle(() =>
        gwPost(`${BASE}/${artifact_id}/summarize`, { language, instructions }),
      ),
  );

  server.tool(
    'artifact_reprocess',
    'Trigger the processing/indexing pipeline for an artifact (re-embed, re-chunk, re-extract).',
    { artifact_id: z.string() },
    async ({ artifact_id }) => handle(() => gwPost(`${BASE}/${artifact_id}/process`)),
  );

  server.tool(
    'artifact_from_youtube',
    'Download a YouTube video, transcribe it, and create an artifact from it.',
    {
      url: z.string().url(),
      project_id: z.string().optional(),
      language: z.string().optional(),
    },
    async ({ url, project_id, language }) =>
      handle(() => gwPost(`${BASE}/youtube`, { url, project_id, language })),
  );

  server.tool(
    'artifact_delete',
    'Delete an artifact by id.',
    { artifact_id: z.string() },
    async ({ artifact_id }) => handle(() => gwDelete(`${BASE}/${artifact_id}`)),
  );

  server.tool(
    'artifact_queue_status',
    'Show pending / in-flight artifact processing jobs.',
    {},
    async () => handle(() => gwGet(`${BASE}/queue`)),
  );
}
