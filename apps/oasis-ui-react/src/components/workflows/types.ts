/**
 * Types for the workflows UI — mirror the server-side shapes in
 * `apps/api-gateway/src/workflows/workflows.types.ts`.
 */

export type NodeType =
  | 'input' | 'output' | 'trigger' | 'mcp_tool' | 'http'
  | 'delay' | 'branch' | 'filter' | 'transform';

export type TriggerType = 'cron' | 'event' | 'manual';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  position?: { x: number; y: number };
  params: Record<string, any>;
  on_error?: 'fail' | 'continue';
}

export interface WorkflowEdge {
  from_node: string;
  from_port?: string;
  to_node: string;
  to_port?: string;
}

export interface Workflow {
  workflow_id: string;
  name: string;
  description?: string;
  version: number;
  enabled: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  created_at: string;
  updated_at: string;
}

export interface Trigger {
  trigger_id: string;
  workflow_id: string;
  type: TriggerType;
  enabled: boolean;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface NodeState {
  status: NodeStatus;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface WorkflowRun {
  run_id: string;
  workflow_id: string;
  trigger_id?: string;
  trigger_type?: TriggerType;
  status: RunStatus;
  input?: any;
  context: Record<string, any>;
  node_states: Record<string, NodeState>;
  output?: any;
  error?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

export const NODE_TYPES: NodeType[] = [
  'trigger', 'input', 'output', 'mcp_tool', 'http', 'delay', 'branch', 'filter', 'transform',
];

export const NODE_TYPE_COLORS: Record<NodeType, string> = {
  trigger:   'border-amber-500/50 bg-amber-950/40',
  input:     'border-sky-500/50 bg-sky-950/40',
  output:    'border-emerald-500/50 bg-emerald-950/40',
  mcp_tool:  'border-purple-500/50 bg-purple-950/40',
  http:      'border-orange-500/50 bg-orange-950/40',
  delay:     'border-slate-500/50 bg-slate-900/40',
  branch:    'border-yellow-500/50 bg-yellow-950/40',
  filter:    'border-yellow-500/50 bg-yellow-950/40',
  transform: 'border-blue-500/50 bg-blue-950/40',
};
