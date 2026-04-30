/**
 * Native tool dispatchers for workflow + trigger operations.
 *
 * These are consumed by the in-app chat agent via `interaction.service.ts`.
 * Each entry:
 *   • Declares the tool name (must be whitelisted in response-generator).
 *   • Provides a dispatcher that reads from the LLM's parsed plan and calls
 *     the corresponding `/api/v1/workflows/*` endpoint directly (no MCP hop).
 *   • Formats the output as a short text blob that goes back to the LLM as
 *     a tool result.
 *
 * Params come through `plan` — strings as sent by the LLM via the
 * `PARAM_<NAME>:` DSL. JSON blobs are strings at this layer; we parse them
 * here. Errors are returned as `{ success:false, output:"..." }` so the LLM
 * can self-correct.
 */

import axios from 'axios';

const GATEWAY_SELF = process.env.OASIS_GATEWAY_SELF_URL || 'http://localhost:8000';
const API = `${GATEWAY_SELF}/api/v1/workflows`;

/** Everything a dispatcher needs from the parsed plan. */
export interface NativePlan {
  tool: string;
  workflow_id?: string;
  run_id?: string;
  trigger_id?: string;
  name?: string;
  description?: string;
  input?: string;                 // JSON for workflow_run
  workflow_json?: string;         // JSON for create/update: {nodes, edges}
  trigger_type?: string;
  trigger_config?: string;        // JSON: cron or event config
  enabled?: string;               // "true" | "second" | "false"
  limit?: string;
  // Incremental node/edge authoring (flat params, friendlier for LLMs
  // than a full PARAM_WORKFLOW_JSON blob):
  node_id?: string;
  node_type?: string;             // input|output|mcp_tool|http|delay|branch|filter|transform
  node_params?: string;           // JSON for the new node's params
  from_node?: string;
  from_port?: string;             // default "out"
  to_node?: string;
  to_port?: string;               // default "in"
}

export interface NativeToolResult {
  success: boolean;
  output: string;
}

/** The tool names the chat agent may call; whitelisted here & in response-generator. */
export const NATIVE_WORKFLOW_TOOLS = new Set<string>([
  'workflow_list',
  'workflow_get',
  'workflow_create',
  'workflow_update',
  'workflow_delete',
  'workflow_run',
  'workflow_runs_list',
  'workflow_get_run',
  'workflow_cancel_run',
  'node_catalog',
  'trigger_create',
  'trigger_list',
  'trigger_update',
  'trigger_delete',
  // Incremental authoring helpers
  'workflow_add_node',
  'workflow_add_edge',
  'workflow_remove_node',
]);

function parseJsonField(raw: string | undefined, fieldName: string): any {
  if (!raw) throw new Error(`${fieldName} is required (pass as JSON)`);
  const s = typeof raw === 'string' ? raw.trim() : raw;
  try { return typeof s === 'string' ? JSON.parse(s) : s; }
  catch (e: any) { throw new Error(`${fieldName} is not valid JSON: ${e.message}`); }
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw == null || raw === '') return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined;
}

function normalise(err: unknown): string {
  const e = err as any;
  if (e?.response?.data?.message) return String(e.response.data.message);
  if (e?.response?.data) return typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
  return e?.message || String(err);
}

function summariseWorkflow(wf: any): string {
  const nodeCount = (wf.nodes || []).length;
  const edgeCount = (wf.edges || []).length;
  return `${wf.workflow_id}  "${wf.name}"  v${wf.version}  ${nodeCount} nodes, ${edgeCount} edges  ${wf.enabled ? 'enabled' : 'disabled'}`;
}

function summariseTrigger(t: any): string {
  const cfg = JSON.stringify(t.config || {});
  return `${t.trigger_id}  type=${t.type}  ${t.enabled ? 'enabled' : 'disabled'}  cfg=${cfg}`;
}

function summariseRun(r: any): string {
  const dur = r.finished_at && r.started_at
    ? `${((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(2)}s`
    : '-';
  return `${r.run_id}  status=${r.status}  trigger=${r.trigger_type || 'manual'}  dur=${dur}`;
}

/* ── Individual dispatchers ─────────────────────────────────────────── */

async function doWorkflowList(): Promise<NativeToolResult> {
  const res = await axios.get(API);
  const list = (res.data || []).map(summariseWorkflow).join('\n');
  return { success: true, output: list || '(no workflows)' };
}

async function doWorkflowGet(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  const res = await axios.get(`${API}/${plan.workflow_id}`);
  return { success: true, output: JSON.stringify(res.data, null, 2) };
}

async function doWorkflowCreate(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.name) throw new Error('name is required');
  const spec = plan.workflow_json ? parseJsonField(plan.workflow_json, 'workflow_json') : { nodes: [], edges: [] };
  const res = await axios.post(API, {
    name: plan.name,
    description: plan.description,
    nodes: spec.nodes || [],
    edges: spec.edges || [],
  });
  return {
    success: true,
    output: `Workflow created: ${summariseWorkflow(res.data)}`,
  };
}

async function doWorkflowUpdate(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  const patch: Record<string, any> = {};
  if (plan.name != null) patch.name = plan.name;
  if (plan.description != null) patch.description = plan.description;
  const en = parseBool(plan.enabled);
  if (en != null) patch.enabled = en;
  if (plan.workflow_json) {
    const spec = parseJsonField(plan.workflow_json, 'workflow_json');
    if (spec.nodes) patch.nodes = spec.nodes;
    if (spec.edges) patch.edges = spec.edges;
  }
  const res = await axios.patch(`${API}/${plan.workflow_id}`, patch);
  return { success: true, output: `Workflow updated: ${summariseWorkflow(res.data)}` };
}

async function doWorkflowDelete(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  await axios.delete(`${API}/${plan.workflow_id}`);
  return { success: true, output: `Workflow ${plan.workflow_id} deleted (and its triggers + runs).` };
}

async function doWorkflowRun(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  const input = plan.input ? parseJsonField(plan.input, 'input') : undefined;
  const res = await axios.post(`${API}/${plan.workflow_id}/run`, { input });
  return {
    success: true,
    output:
      `Run enqueued: ${res.data.run_id}  (status=${res.data.status}). ` +
      `Poll with workflow_get_run PARAM_RUN_ID: ${res.data.run_id}.`,
  };
}

async function doWorkflowRunsList(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  const limit = plan.limit ? parseInt(plan.limit, 10) : 20;
  const res = await axios.get(`${API}/${plan.workflow_id}/runs`, { params: { limit } });
  const lines = (res.data || []).map(summariseRun).join('\n');
  return { success: true, output: lines || '(no runs)' };
}

async function doWorkflowGetRun(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.run_id) throw new Error('run_id is required');
  const res = await axios.get(`${API}/runs/${plan.run_id}`);
  const r = res.data;
  const nodeLines = Object.entries(r.node_states || {})
    .map(([nid, st]: [string, any]) => `  ${nid}: ${st.status}${st.error ? ` (${st.error})` : ''}`)
    .join('\n');
  return {
    success: true,
    output: [
      `run_id: ${r.run_id}`,
      `status: ${r.status}  trigger=${r.trigger_type || 'manual'}`,
      r.error ? `error: ${r.error}` : null,
      r.output !== undefined ? `output: ${JSON.stringify(r.output)}` : null,
      nodeLines ? `nodes:\n${nodeLines}` : null,
    ].filter(Boolean).join('\n'),
  };
}

async function doWorkflowCancelRun(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.run_id) throw new Error('run_id is required');
  const res = await axios.post(`${API}/runs/${plan.run_id}/cancel`);
  return { success: true, output: `Run ${plan.run_id} → ${res.data.status}` };
}

async function doNodeCatalog(): Promise<NativeToolResult> {
  const res = await axios.get(`${API}/node-catalog`);
  return { success: true, output: `Available node types: ${(res.data?.node_types || []).join(', ')}` };
}

async function doTriggerCreate(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  if (!plan.trigger_type) throw new Error('trigger_type is required (cron|event|manual)');
  const config = plan.trigger_config ? parseJsonField(plan.trigger_config, 'trigger_config') : {};
  const enabled = parseBool(plan.enabled);
  const res = await axios.post(`${API}/${plan.workflow_id}/triggers`, {
    type: plan.trigger_type,
    enabled: enabled ?? true,
    config,
  });
  return { success: true, output: `Trigger created: ${summariseTrigger(res.data)}` };
}

async function doTriggerList(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  const res = await axios.get(`${API}/${plan.workflow_id}/triggers`);
  const lines = (res.data || []).map(summariseTrigger).join('\n');
  return { success: true, output: lines || '(no triggers)' };
}

async function doTriggerUpdate(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.trigger_id) throw new Error('trigger_id is required');
  const patch: Record<string, any> = {};
  const en = parseBool(plan.enabled);
  if (en != null) patch.enabled = en;
  if (plan.trigger_config) patch.config = parseJsonField(plan.trigger_config, 'trigger_config');
  const res = await axios.patch(`${API}/triggers/${plan.trigger_id}`, patch);
  return { success: true, output: `Trigger updated: ${summariseTrigger(res.data)}` };
}

async function doTriggerDelete(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.trigger_id) throw new Error('trigger_id is required');
  await axios.delete(`${API}/triggers/${plan.trigger_id}`);
  return { success: true, output: `Trigger ${plan.trigger_id} deleted.` };
}

/* ── Incremental authoring ──────────────────────────────────────────── */

async function doWorkflowAddNode(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  if (!plan.node_id) throw new Error('node_id is required');
  if (!plan.node_type) throw new Error('node_type is required');
  const params = plan.node_params ? parseJsonField(plan.node_params, 'node_params') : {};
  const get = await axios.get(`${API}/${plan.workflow_id}`);
  const wf = get.data;
  if (wf.nodes?.some((n: any) => n.id === plan.node_id)) {
    throw new Error(`node_id "${plan.node_id}" already exists in this workflow`);
  }
  const newNode = {
    id: plan.node_id,
    type: plan.node_type,
    params,
    position: { x: 120 + (wf.nodes?.length || 0) * 220, y: 180 },
  };
  const nextNodes = [...(wf.nodes || []), newNode];
  const res = await axios.patch(`${API}/${plan.workflow_id}`, { nodes: nextNodes });
  return { success: true, output: `Node added: ${plan.node_id} (${plan.node_type}). Workflow now has ${res.data.nodes.length} nodes.` };
}

async function doWorkflowAddEdge(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  if (!plan.from_node) throw new Error('from_node is required');
  if (!plan.to_node) throw new Error('to_node is required');
  const get = await axios.get(`${API}/${plan.workflow_id}`);
  const wf = get.data;
  const exists = wf.edges?.some((e: any) =>
    e.from_node === plan.from_node && (e.from_port || 'out') === (plan.from_port || 'out') &&
    e.to_node === plan.to_node && (e.to_port || 'in') === (plan.to_port || 'in'));
  if (exists) return { success: true, output: 'Edge already exists — no-op.' };
  const newEdge = {
    from_node: plan.from_node,
    from_port: plan.from_port || 'out',
    to_node: plan.to_node,
    to_port: plan.to_port || 'in',
  };
  const nextEdges = [...(wf.edges || []), newEdge];
  const res = await axios.patch(`${API}/${plan.workflow_id}`, { edges: nextEdges });
  return { success: true, output: `Edge added: ${newEdge.from_node}.${newEdge.from_port} → ${newEdge.to_node}.${newEdge.to_port}. Workflow now has ${res.data.edges.length} edges.` };
}

async function doWorkflowRemoveNode(plan: NativePlan): Promise<NativeToolResult> {
  if (!plan.workflow_id) throw new Error('workflow_id is required');
  if (!plan.node_id) throw new Error('node_id is required');
  const get = await axios.get(`${API}/${plan.workflow_id}`);
  const wf = get.data;
  const nextNodes = (wf.nodes || []).filter((n: any) => n.id !== plan.node_id);
  const nextEdges = (wf.edges || []).filter((e: any) => e.from_node !== plan.node_id && e.to_node !== plan.node_id);
  const res = await axios.patch(`${API}/${plan.workflow_id}`, { nodes: nextNodes, edges: nextEdges });
  return { success: true, output: `Node removed: ${plan.node_id}. Workflow now has ${res.data.nodes.length} nodes and ${res.data.edges.length} edges.` };
}

const DISPATCHERS: Record<string, (plan: NativePlan) => Promise<NativeToolResult>> = {
  workflow_list:       doWorkflowList,
  workflow_get:        doWorkflowGet,
  workflow_create:     doWorkflowCreate,
  workflow_update:     doWorkflowUpdate,
  workflow_delete:     doWorkflowDelete,
  workflow_run:        doWorkflowRun,
  workflow_runs_list:  doWorkflowRunsList,
  workflow_get_run:    doWorkflowGetRun,
  workflow_cancel_run: doWorkflowCancelRun,
  node_catalog:        doNodeCatalog,
  trigger_create:      doTriggerCreate,
  trigger_list:        doTriggerList,
  trigger_update:      doTriggerUpdate,
  trigger_delete:      doTriggerDelete,
  workflow_add_node:   doWorkflowAddNode,
  workflow_add_edge:   doWorkflowAddEdge,
  workflow_remove_node: doWorkflowRemoveNode,
};

export async function dispatchNativeWorkflowTool(plan: NativePlan): Promise<NativeToolResult> {
  const fn = DISPATCHERS[plan.tool];
  if (!fn) return { success: false, output: `unknown native tool: ${plan.tool}` };
  // Diagnostic: dump the params the chat pipeline actually passed in. Useful
  // while tuning the LLM prompt for incremental workflow authoring.
  // eslint-disable-next-line no-console
  console.log(`[nwf] ${plan.tool}`, {
    workflow_id: plan.workflow_id, run_id: plan.run_id, trigger_id: plan.trigger_id,
    name: plan.name, node_id: plan.node_id, node_type: plan.node_type,
    node_params_len: plan.node_params?.length ?? 0,
    from_node: plan.from_node, to_node: plan.to_node,
    has_workflow_json: !!plan.workflow_json,
  });
  try {
    return await fn(plan);
  } catch (err) {
    return { success: false, output: normalise(err) };
  }
}
