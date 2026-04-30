/**
 * Built-in node executors.
 *
 * All pure / in-process except `delay`. These register themselves once at
 * module import time via `registerNode`.
 */

import { registerNode, type NodeExecutor } from '../node-registry';
import { buildJexlContext, evalBool, evalExpr, interpolateDeep } from '../interpolate';

/* ── input ─────────────────────────────────────────────────────────
 * Emits `run.input` on `out`. Typical use: single-source entry node.
 */
const inputNode: NodeExecutor = async ({ run }) => {
  return { out: run.input };
};

/* ── output ───────────────────────────────────────────────────────
 * Collects its `in` value into the run-level output. The engine reads back
 * `run.output` at the end, but we return the value so downstream nodes can
 * also read it if wired.
 */
const outputNode: NodeExecutor = async ({ inputs }) => {
  return { out: inputs.in };
};

/* ── delay ────────────────────────────────────────────────────────
 * params: { ms: number }
 */
const delayNode: NodeExecutor = async ({ node, inputs, abortSignal }) => {
  const ms = Number(node.params?.ms ?? 0);
  if (ms > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      abortSignal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('cancelled'));
      });
    });
  }
  return { out: inputs.in };
};

/* ── branch ───────────────────────────────────────────────────────
 * params: { expression: "jexl" }
 * Routes the incoming `in` to `true` or `false` port based on evaluated
 * boolean. Other-branch downstream nodes become unreachable (engine marks
 * them `skipped`).
 */
const branchNode: NodeExecutor = async ({ node, inputs, run }) => {
  const ctx = buildJexlContext({
    inputs,
    nodes: collectPriorOutputs(run),
    run_input: run.input,
    run_context: run.context,
  });
  const passed = evalBool(String(node.params?.expression ?? 'false'), ctx);
  return passed ? { true: inputs.in } : { false: inputs.in };
};

/* ── filter ──────────────────────────────────────────────────────
 * params: { expression: "jexl" }
 * Emits on `out` only if expression is truthy; otherwise emits nothing so
 * downstream nodes get skipped.
 */
const filterNode: NodeExecutor = async ({ node, inputs, run }) => {
  const ctx = buildJexlContext({
    inputs,
    nodes: collectPriorOutputs(run),
    run_input: run.input,
    run_context: run.context,
  });
  const passed = evalBool(String(node.params?.expression ?? 'false'), ctx);
  return passed ? { out: inputs.in } : {};
};

/* ── transform ───────────────────────────────────────────────────
 * params: { expression: "jexl" }
 * Returns the evaluated value on `out`. Useful for reshaping data between
 * nodes (`{ q: in.goal, limit: 5 }` etc.).
 */
const transformNode: NodeExecutor = async ({ node, inputs, run }) => {
  const ctx = buildJexlContext({
    inputs,
    nodes: collectPriorOutputs(run),
    run_input: run.input,
    run_context: run.context,
  });
  const value = evalExpr(String(node.params?.expression ?? 'in'), ctx);
  return { out: value };
};

/** Helper: snapshot of all already-completed node outputs for JEXL context. */
function collectPriorOutputs(run: ExpandedRun): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const [nid, state] of Object.entries(run.node_states || {})) {
    if (state?.output) out[nid] = state.output;
  }
  return out;
}

/** Minimal run shape the built-ins need. */
type ExpandedRun = {
  input?: any;
  context?: Record<string, any>;
  node_states: Record<string, { output?: Record<string, any> }>;
};

/* ── trigger ──────────────────────────────────────────────────────
 * Visual start node. At run time it's indistinguishable from `input` —
 * it emits run.input on its `out` port. At *design* time (on the canvas)
 * its params define a cron/event/manual trigger which the server
 * reconciles into a real Trigger entity on workflow save.
 */
const triggerNode: NodeExecutor = async ({ run }) => {
  return { out: run.input };
};

export function registerBuiltins() {
  registerNode('input', inputNode);
  registerNode('output', outputNode);
  registerNode('trigger', triggerNode);
  registerNode('delay', delayNode);
  registerNode('branch', branchNode);
  registerNode('filter', filterNode);
  registerNode('transform', transformNode);
}
