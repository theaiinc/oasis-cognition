/**
 * Workflow engine — parallel topological execution of a workflow DAG.
 *
 * Contract:
 *   engine.executeRun(run, workflow, { abortSignal })  →  finished run
 *
 * The engine mutates the passed run object in place and persists progress
 * via `store.saveRun()` + `store.appendRunEvent()` so SSE listeners see
 * each node transition.
 *
 * Execution rules:
 *   • Topological order with round-based concurrent dispatch. Each round
 *     discovers all nodes whose dependencies are satisfied and runs them
 *     in parallel via Promise.allSettled.
 *   • When a round finishes, the engine re-evaluates the DAG and starts
 *     the next round with any newly-ready nodes.
 *   • A node is "ready" when all its incoming edges originate from nodes
 *     that have emitted a value on the required from_port. If an incoming
 *     edge's upstream emitted no value on that port (e.g. branch's untaken
 *     side, filter that didn't pass) or was skipped/failed, the downstream
 *     node is marked `skipped`.
 *   • `output` nodes write their received value to `run.output`.
 *   • Cancellation: if abortSignal fires, running nodes are skipped
 *     and remaining nodes are marked `skipped`; run status → `cancelled`.
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
  /** Max number of nodes to run concurrently per round.
   *  0 = unlimited (all ready nodes fire at once). */
  maxConcurrency?: number;
}

/** Build a lookup of incoming edges keyed by target node id. */
function buildIncomingEdges(
  edges: Array<{ from_node: string; to_node: string; from_port?: string; to_port?: string }>,
): Map<string, Array<{ from_node: string; from_port: string; to_port: string }>> {
  const incomingByNode = new Map<string, Array<{ from_node: string; from_port: string; to_port: string }>>();
  for (const e of edges) {
    if (!incomingByNode.has(e.to_node)) incomingByNode.set(e.to_node, []);
    incomingByNode.get(e.to_node)!.push({
      from_node: e.from_node,
      from_port: e.from_port || 'out',
      to_port: e.to_port || 'in',
    });
  }
  return incomingByNode;
}

/**
 * Determine if a node is ready to execute based on its upstream states.
 *
 * Returns one of three outcomes:
 *   { ready: true,  skip: false }  — all dependencies satisfied, execute.
 *   { ready: false, skip: true  }  — upstream skipped/failed/no output.
 *   { ready: false, skip: false }  — upstream still running, try again later.
 */
function computeReadiness(
  nodeId: string,
  incoming: Array<{ from_node: string; from_port: string; to_port: string }> | undefined,
  nodeStates: Record<string, any>,
): { ready: boolean; skip: boolean; inputs?: Record<string, any>; skipReason?: string } {
  if (!incoming || incoming.length === 0) {
    return { ready: true, skip: false, inputs: {} };
  }

  const inputs: Record<string, any> = {};
  for (const e of incoming) {
    const up = nodeStates[e.from_node];
    // Upstream not evaluated yet — not ready, don't skip (might be dispatched this round)
    if (!up || up.status === 'pending') return { ready: false, skip: false };
    if (up.status === 'skipped') {
      return { ready: false, skip: true, skipReason: `upstream ${e.from_node} was skipped` };
    }
    if (up.status === 'failed') {
      return { ready: false, skip: true, skipReason: `upstream ${e.from_node} failed` };
    }
    if (up.status !== 'completed') {
      // Still running — not ready
      return { ready: false, skip: false };
    }
    // Presence check, not truthy check — nodes may legitimately emit
    // `undefined` / `null` on a port.
    const upstreamOut = up.output || {};
    if (!(e.from_port in upstreamOut)) {
      return { ready: false, skip: true, skipReason: `upstream ${e.from_node} emitted no value on port ${e.from_port}` };
    }
    inputs[e.to_port] = upstreamOut[e.from_port];
  }
  return { ready: true, skip: false, inputs };
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

  const nodeById = new Map(nodes.map(n => [n.id, n] as const));
  const incomingByNode = buildIncomingEdges(edges);
  const dispatched = new Set<string>();
  let cancelledByNode: string | undefined;
  let cancelledReason: string | undefined;

  const aborted = () => opts.abortSignal?.aborted === true;

  /** Skip a node (upstream prevented execution). Propagates downstream. */
  async function skipNode(nodeId: string, reason?: string): Promise<void> {
    if (dispatched.has(nodeId)) return;
    dispatched.add(nodeId);
    run.node_states[nodeId] = { status: 'skipped', error: reason };
    await store.saveRun(run);
    await store.appendRunEvent(run.run_id, 'node', { node_id: nodeId, status: 'skipped', error: reason });

    // Propagate downstream: any node that depends on this one should also skip
    for (const n of order) {
      const incoming = incomingByNode.get(n.id) || [];
      const dependsOnSkipped = incoming.some(e => e.from_node === nodeId);
      if (dependsOnSkipped && !dispatched.has(n.id)) {
        await skipNode(n.id, `upstream ${nodeId} was skipped`);
      }
    }
  }

  /** Execute a single node. Returns when it finishes (or is skipped/failed). */
  async function executeNode(node: WorkflowNode): Promise<void> {
    const { id, type, on_error } = node;
    const incoming = incomingByNode.get(id) || [];
    const readiness = computeReadiness(id, incoming, run.node_states);

    if (readiness.skip) {
      await skipNode(id, readiness.skipReason);
      return;
    }

    if (!readiness.ready) {
      return; // caller should not dispatch unready nodes
    }

    // ── Interpolate params ─────────────────────────────────────
    const priorOutputs: Record<string, Record<string, any>> = {};
    for (const [nid, state] of Object.entries(run.node_states)) {
      if (state?.output) priorOutputs[nid] = state.output;
    }
    const jexlCtx = buildJexlContext({
      inputs: readiness.inputs!,
      nodes: priorOutputs,
      run_input: run.input,
      run_context: run.context,
    });
    const interpolatedParams = interpolateDeep(node.params || {}, jexlCtx);

    run.node_states[id] = {
      status: 'running',
      input: readiness.inputs,
      started_at: iso(),
    };
    await store.saveRun(run);
    await store.appendRunEvent(run.run_id, 'node', { node_id: id, status: 'running' });

    try {
      const executor = getExecutor(type);
      if (!executor) {
        throw new Error(`No executor registered for node type "${type}"`);
      }

      const nodeWithInterpolatedParams: WorkflowNode = { ...node, params: interpolatedParams };
      const output = await executor({
        node: nodeWithInterpolatedParams,
        inputs: readiness.inputs!,
        run,
        abortSignal: opts.abortSignal,
      });

      if (aborted()) return;

      run.node_states[id] = {
        status: 'completed',
        input: readiness.inputs,
        output,
        started_at: run.node_states[id].started_at,
        finished_at: iso(),
      };
      await store.saveRun(run);
      await store.appendRunEvent(run.run_id, 'node', {
        node_id: id, status: 'completed', output,
      });

      // output node: write the received value to run.output
      if (type === 'output') {
        run.output = readiness.inputs?.in;
      }
    } catch (err: any) {
      if (aborted()) return;

      const message = err?.message || String(err);
      run.node_states[id] = {
        status: 'failed',
        input: readiness.inputs,
        error: message,
        started_at: run.node_states[id].started_at,
        finished_at: iso(),
      };
      await store.saveRun(run);
      await store.appendRunEvent(run.run_id, 'node', {
        node_id: id, status: 'failed', error: message,
      });
      logger.warn(`node ${id} (${type}) failed: ${message}`);

      if (on_error !== 'continue') {
        cancelledByNode = id;
        cancelledReason = message;
      }
    }
  }

  // ── Round-based parallel execution ──────────────────────────────
  // Each round: find ready nodes → fire them in parallel → wait →
  // handle cancelled/skipped → repeat until no nodes remain.

  while (!cancelledByNode && !aborted()) {
    // Find all nodes that are ready (all deps met) and not yet dispatched
    const readyNodes = order.filter(n => {
      if (dispatched.has(n.id)) return false;
      const incoming = incomingByNode.get(n.id) || [];
      const r = computeReadiness(n.id, incoming, run.node_states);
      return r.ready;
    });

    // Find nodes that should be skipped (upstream failed/skipped/no-output)
    const toSkip = order.filter(n => {
      if (dispatched.has(n.id)) return false;
      const incoming = incomingByNode.get(n.id) || [];
      if (incoming.length === 0) return false; // source nodes never skipped
      const r = computeReadiness(n.id, incoming, run.node_states);
      return r.skip;
    });

    // Skip nodes that can't execute
    for (const node of toSkip) {
      await skipNode(node.id);
    }

    // If no ready nodes and nothing to skip, we're done
    if (readyNodes.length === 0 && toSkip.length === 0) break;

    // Dispatch only the current batch. Ready nodes beyond the concurrency
    // limit must remain undispatched so the next round can execute them.
    let batch = readyNodes;
    if (opts.maxConcurrency && opts.maxConcurrency > 0 && batch.length > opts.maxConcurrency) {
      // Limit concurrency: process in chunks
      batch = batch.slice(0, opts.maxConcurrency);
    }
    for (const n of batch) dispatched.add(n.id);

    await Promise.allSettled(batch.map(n => executeNode(n)));

    // If a node execution caused a cancellation, break out
    if (cancelledByNode) break;
  }

  // ── Finalise run ────────────────────────────────────────────────
  // Mark all remaining pending/skipped nodes
  const failOrCancelMsg = cancelledReason || 'run cancelled';

  for (const n of order) {
    const state = run.node_states[n.id];
    if (state.status === 'pending' || state.status === 'running') {
      run.node_states[n.id] = { ...state, status: 'skipped' };
    }
    if (!dispatched.has(n.id)) {
      dispatched.add(n.id);
    }
  }

  if (aborted() && run.status === 'running') {
    run.status = 'cancelled';
    run.error = 'run cancelled';
  } else if (cancelledByNode) {
    run.status = 'failed';
    run.error = failOrCancelMsg;
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
