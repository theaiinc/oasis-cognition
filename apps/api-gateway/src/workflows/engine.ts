/**
 * Workflow engine — topological execution of a workflow DAG.
 *
 * Contract:
 *   engine.execute(run, workflow, { abortSignal })  →  finished run
 *
 * The engine mutates the passed run object in place and persists progress
 * via `store.saveRun()` + `store.appendRunEvent()` so SSE listeners see
 * each node transition.
 *
 * Execution rules:
 *   • Topological order (Kahn's algorithm). Cycles are rejected with a
 *     `failed` run before any node executes.
 *   • A node is "ready" when all its incoming edges originate from nodes
 *     that have emitted a value on the required from_port. If an incoming
 *     edge's upstream emitted no value on that port (e.g. branch's untaken
 *     side, filter that didn't pass), the downstream node is marked
 *     `skipped` — which in turn propagates to its descendants.
 *   • `output` nodes write their received value to `run.output`.
 *   • Cancellation: if abortSignal fires, the currently-running node is
 *     aborted (it receives the signal) and remaining nodes are marked
 *     `skipped`; run status → `cancelled`.
 */

import { Logger } from '@nestjs/common';
import { getExecutor } from './node-registry';
import { buildJexlContext, interpolateDeep } from './interpolate';
import type { WorkflowStore } from './store/redis-store';
import type { Workflow, WorkflowNode, WorkflowRun } from './workflows.types';

const logger = new Logger('WorkflowEngine');

function iso(): string { return new Date().toISOString(); }

/** Sort nodes in topological order; throws on a cycle. */
function topoSort(nodes: WorkflowNode[], edges: Array<{ from_node: string; to_node: string }>): WorkflowNode[] {
  const byId = new Map(nodes.map(n => [n.id, n] as const));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) { inDeg.set(n.id, 0); adj.set(n.id, new Set()); }
  for (const e of edges) {
    if (!byId.has(e.from_node) || !byId.has(e.to_node)) continue;
    if (!adj.get(e.from_node)!.has(e.to_node)) {
      adj.get(e.from_node)!.add(e.to_node);
      inDeg.set(e.to_node, (inDeg.get(e.to_node) || 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDeg) if (deg === 0) queue.push(id);
  const out: WorkflowNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const n = byId.get(id);
    if (n) out.push(n);
    for (const next of adj.get(id) || []) {
      const d = (inDeg.get(next) || 0) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (out.length !== nodes.length) throw new Error('workflow DAG has a cycle');
  return out;
}

export interface ExecuteOptions {
  abortSignal?: AbortSignal;
}

export async function executeRun(
  run: WorkflowRun,
  workflow: Workflow,
  store: WorkflowStore,
  opts: ExecuteOptions = {},
): Promise<WorkflowRun> {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];

  run.status = 'running';
  run.started_at = iso();
  await store.saveRun(run);
  await store.appendRunEvent(run.run_id, 'status', { status: run.status });

  // Seed per-node states as pending
  for (const n of nodes) {
    run.node_states[n.id] = run.node_states[n.id] || { status: 'pending' };
  }

  let order: WorkflowNode[];
  try {
    order = topoSort(nodes, edges);
  } catch (err: any) {
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = iso();
    await store.saveRun(run);
    await store.appendRunEvent(run.run_id, 'status', { status: run.status, error: run.error });
    return run;
  }

  // Incoming edges lookup
  const incomingByNode = new Map<string, Array<{ from_node: string; from_port: string; to_port: string }>>();
  for (const e of edges) {
    if (!incomingByNode.has(e.to_node)) incomingByNode.set(e.to_node, []);
    incomingByNode.get(e.to_node)!.push({
      from_node: e.from_node,
      from_port: e.from_port || 'out',
      to_port: e.to_port || 'in',
    });
  }

  const aborted = () => opts.abortSignal?.aborted === true;

  for (const node of order) {
    if (aborted()) break;

    // Resolve inputs; any upstream that is `skipped` or `failed` OR didn't
    // emit the required from_port causes this node to skip (unless it has
    // no incoming edges at all, in which case it's a source node).
    const incoming = incomingByNode.get(node.id) || [];
    let shouldSkip = false;
    const inputs: Record<string, any> = {};

    for (const e of incoming) {
      const upstreamState = run.node_states[e.from_node];
      if (!upstreamState || upstreamState.status === 'skipped' || upstreamState.status === 'failed') {
        shouldSkip = true;
        break;
      }
      if (upstreamState.status !== 'completed') {
        // This shouldn't happen with topo order, but be defensive.
        shouldSkip = true;
        break;
      }
      // Presence check, not truthy check — nodes may legitimately emit
      // `undefined` / `null` on a port. We skip only when the port key was
      // absent from the output map (e.g. filter didn't match, branch chose
      // the other side).
      const upstreamOut = upstreamState.output || {};
      if (!(e.from_port in upstreamOut)) {
        shouldSkip = true;
        break;
      }
      inputs[e.to_port] = upstreamOut[e.from_port];
    }

    if (shouldSkip) {
      run.node_states[node.id] = { status: 'skipped' };
      await store.saveRun(run);
      await store.appendRunEvent(run.run_id, 'node', { node_id: node.id, status: 'skipped' });
      continue;
    }

    // Interpolate params against the current context
    const priorOutputs: Record<string, Record<string, any>> = {};
    for (const [nid, state] of Object.entries(run.node_states)) {
      if (state?.output) priorOutputs[nid] = state.output;
    }
    const jexlCtx = buildJexlContext({
      inputs,
      nodes: priorOutputs,
      run_input: run.input,
      run_context: run.context,
    });
    const interpolatedParams = interpolateDeep(node.params || {}, jexlCtx);

    const executor = getExecutor(node.type);
    if (!executor) {
      run.node_states[node.id] = {
        status: 'failed',
        error: `No executor registered for node type "${node.type}"`,
        started_at: iso(),
        finished_at: iso(),
      };
      await store.saveRun(run);
      await store.appendRunEvent(run.run_id, 'node', {
        node_id: node.id, status: 'failed', error: run.node_states[node.id].error,
      });
      if (node.on_error !== 'continue') {
        run.status = 'failed';
        run.error = run.node_states[node.id].error;
        break;
      }
      continue;
    }

    run.node_states[node.id] = {
      status: 'running',
      input: inputs,
      started_at: iso(),
    };
    await store.saveRun(run);
    await store.appendRunEvent(run.run_id, 'node', { node_id: node.id, status: 'running' });

    try {
      const nodeWithInterpolatedParams: WorkflowNode = { ...node, params: interpolatedParams };
      const output = await executor({
        node: nodeWithInterpolatedParams,
        inputs,
        run,
        abortSignal: opts.abortSignal,
      });
      run.node_states[node.id] = {
        status: 'completed',
        input: inputs,
        output,
        started_at: run.node_states[node.id].started_at,
        finished_at: iso(),
      };
      await store.saveRun(run);
      await store.appendRunEvent(run.run_id, 'node', {
        node_id: node.id, status: 'completed', output,
      });

      // output node: write the received value to run.output
      if (node.type === 'output') {
        run.output = inputs.in;
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      run.node_states[node.id] = {
        status: 'failed',
        input: inputs,
        error: message,
        started_at: run.node_states[node.id].started_at,
        finished_at: iso(),
      };
      await store.saveRun(run);
      await store.appendRunEvent(run.run_id, 'node', {
        node_id: node.id, status: 'failed', error: message,
      });
      logger.warn(`node ${node.id} (${node.type}) failed: ${message}`);
      if (node.on_error !== 'continue') {
        run.status = 'failed';
        run.error = message;
        break;
      }
    }
  }

  if (aborted() && run.status === 'running') {
    run.status = 'cancelled';
    run.error = 'run cancelled';
    for (const n of nodes) {
      if (run.node_states[n.id].status === 'pending' || run.node_states[n.id].status === 'running') {
        run.node_states[n.id] = { ...run.node_states[n.id], status: 'skipped' };
      }
    }
  } else if (run.status === 'running') {
    run.status = 'completed';
  }

  run.finished_at = iso();
  await store.saveRun(run);
  await store.appendRunEvent(run.run_id, 'status', {
    status: run.status, error: run.error, output: run.output,
  });
  return run;
}
