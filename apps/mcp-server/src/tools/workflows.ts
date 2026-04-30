/**
 * Workflow + Trigger tools — wrap the api-gateway's `/api/v1/workflows`
 * surface so voice assistants and chat clients can author and run workflows.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwDelete, gwGet, gwPatch, gwPost } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/workflows';

const WorkflowNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['input', 'output', 'trigger', 'mcp_tool', 'http', 'delay', 'branch', 'filter', 'transform']),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  params: z.record(z.any()),
  on_error: z.enum(['fail', 'continue']).optional(),
});

const WorkflowEdgeSchema = z.object({
  from_node: z.string(),
  from_port: z.string().optional(),
  to_node: z.string(),
  to_port: z.string().optional(),
});

export function registerWorkflowTools(server: McpServer) {
  /* ── Node catalogue ───────────────────────────────────────────── */

  server.tool(
    'node_catalog',
    'List the node types currently registered in the workflow engine (useful before composing a workflow).',
    {},
    async () => handle(() => gwGet(`${BASE}/node-catalog`)),
  );

  /* ── Workflows CRUD ──────────────────────────────────────────── */

  server.tool(
    'workflow_create',
    'Create a new workflow. Provide nodes + edges to initialise the graph, or leave empty and patch later with workflow_update. Node params support `{{in.foo}}`/`{{nodes.x.out}}` interpolation.',
    {
      name: z.string(),
      description: z.string().optional(),
      enabled: z.boolean().optional(),
      nodes: z.array(WorkflowNodeSchema).optional(),
      edges: z.array(WorkflowEdgeSchema).optional(),
    },
    async (args) => handle(() => gwPost(BASE, args)),
  );

  server.tool(
    'workflow_list',
    'List all workflows (newest first).',
    {},
    async () => handle(() => gwGet(BASE)),
  );

  server.tool(
    'workflow_get',
    'Get one workflow by id.',
    { workflow_id: z.string() },
    async ({ workflow_id }) => handle(() => gwGet(`${BASE}/${workflow_id}`)),
  );

  server.tool(
    'workflow_update',
    'Patch an existing workflow. Fields absent from the patch are left untouched. Supplying `nodes` / `edges` replaces them wholesale.',
    {
      workflow_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      enabled: z.boolean().optional(),
      nodes: z.array(WorkflowNodeSchema).optional(),
      edges: z.array(WorkflowEdgeSchema).optional(),
    },
    async ({ workflow_id, ...patch }) => handle(() => gwPatch(`${BASE}/${workflow_id}`, patch)),
  );

  server.tool(
    'workflow_delete',
    'Delete a workflow (cascades to its triggers and runs).',
    { workflow_id: z.string() },
    async ({ workflow_id }) => handle(() => gwDelete(`${BASE}/${workflow_id}`)),
  );

  /* ── Runs ─────────────────────────────────────────────────────── */

  server.tool(
    'workflow_run',
    'Manually run a workflow with an optional input payload.',
    {
      workflow_id: z.string(),
      input: z.any().optional(),
      context: z.record(z.any()).optional(),
    },
    async ({ workflow_id, input, context }) =>
      handle(() => gwPost(`${BASE}/${workflow_id}/run`, { input, context })),
  );

  server.tool(
    'workflow_runs_list',
    'List recent runs for a workflow.',
    {
      workflow_id: z.string(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ workflow_id, limit }) =>
      handle(() => gwGet(`${BASE}/${workflow_id}/runs`, { limit })),
  );

  server.tool(
    'workflow_get_run',
    'Inspect a single run (full node_states + output).',
    { run_id: z.string() },
    async ({ run_id }) => handle(() => gwGet(`${BASE}/runs/${run_id}`)),
  );

  server.tool(
    'workflow_cancel_run',
    'Cancel a running or queued run.',
    { run_id: z.string() },
    async ({ run_id }) => handle(() => gwPost(`${BASE}/runs/${run_id}/cancel`)),
  );

  /* ── Triggers ────────────────────────────────────────────────── */

  server.tool(
    'trigger_create',
    'Attach a trigger to a workflow. cron config is `{expression, timezone}` (e.g. "0 9 * * MON", "America/Los_Angeles"). event config is `{event_type?, filter?}` matching against the `oasis:events` Redis stream.',
    {
      workflow_id: z.string(),
      type: z.enum(['cron', 'event', 'manual']),
      enabled: z.boolean().optional(),
      config: z.record(z.any()),
    },
    async ({ workflow_id, ...dto }) =>
      handle(() => gwPost(`${BASE}/${workflow_id}/triggers`, dto)),
  );

  server.tool(
    'trigger_list',
    'List triggers attached to a workflow.',
    { workflow_id: z.string() },
    async ({ workflow_id }) =>
      handle(() => gwGet(`${BASE}/${workflow_id}/triggers`)),
  );

  server.tool(
    'trigger_update',
    'Enable/disable or reconfigure a trigger. `type` cannot change.',
    {
      trigger_id: z.string(),
      enabled: z.boolean().optional(),
      config: z.record(z.any()).optional(),
    },
    async ({ trigger_id, ...patch }) =>
      handle(() => gwPatch(`${BASE}/triggers/${trigger_id}`, patch)),
  );

  server.tool(
    'trigger_delete',
    'Delete a trigger.',
    { trigger_id: z.string() },
    async ({ trigger_id }) => handle(() => gwDelete(`${BASE}/triggers/${trigger_id}`)),
  );
}
