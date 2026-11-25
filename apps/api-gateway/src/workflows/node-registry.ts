/**
 * Node executor registry.
 *
 * An executor is a pure function (modulo side effects on the outside world
 * like HTTP calls) that takes resolved inputs + interpolated params + the
 * active run and returns a port→value map.
 *
 * New node types register by calling `registerNode(type, executor)` at
 * module-init time. The engine looks up executors here.
 */

import type { NodeType, WorkflowNode, WorkflowRun } from './workflows.types';

export interface ExecutorCtx {
  /** The node being executed (with params already interpolated). */
  node: WorkflowNode;
  /** Inputs keyed by to_port (default port name: "in"). */
  inputs: Record<string, any>;
  /** The current run (read-only view; engine owns mutations). */
  run: WorkflowRun;
  /** Signal that fires if the run is cancelled; executors should abort. */
  abortSignal?: AbortSignal;
}

export type NodeExecutor = (ctx: ExecutorCtx) => Promise<Record<string, any>>;

/** JSON Schema for a node's params, shown in the node catalog. */
export type NodeParamSchema = Record<string, any>;

const EXECUTORS = new Map<NodeType, NodeExecutor>();
const PARAM_SCHEMAS = new Map<NodeType, NodeParamSchema>();

export function registerNode(type: NodeType, executor: NodeExecutor, params?: NodeParamSchema): void {
  EXECUTORS.set(type, executor);
  if (params) PARAM_SCHEMAS.set(type, params);
}

/** Param schemas of the node types that declare one. */
export function listParamSchemas(): Record<string, NodeParamSchema> {
  return Object.fromEntries(PARAM_SCHEMAS);
}

export function getExecutor(type: NodeType): NodeExecutor | undefined {
  return EXECUTORS.get(type);
}

export function listRegisteredTypes(): NodeType[] {
  return [...EXECUTORS.keys()];
}
