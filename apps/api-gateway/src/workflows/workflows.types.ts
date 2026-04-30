/**
 * Workflow + Trigger + Run data model.
 *
 * A Workflow is a DAG of Nodes connected by Edges. Triggers fire workflow
 * runs (cron, event, or manual). A Run is the record of one execution, with
 * per-node state captured as the engine advances through topological order.
 */

export type NodeType =
  | 'input'      // implicit start node: emits run.input on `out`
  | 'output'     // collects its incoming value into run.output
  | 'trigger'    // visual start node: when the attached cron/event/manual trigger fires, this is the graph's entry point
  | 'mcp_tool'   // dispatches a call to the Oasis MCP server
  | 'http'       // generic HTTP request
  | 'delay'      // waits N milliseconds
  | 'branch'     // routes to `true` or `false` port based on a JEXL expression
  | 'filter'     // pass-through if condition is true, else emits nothing
  | 'transform'; // JEXL expression produces the output value

export type TriggerType = 'cron' | 'event' | 'manual';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  /** UI position; irrelevant to execution. */
  position?: { x: number; y: number };
  /** Node-type-specific params. Strings support {{path.to.value}} interpolation. */
  params: Record<string, any>;
  /** If true, an executor failure marks the node `failed` but the run continues. */
  on_error?: 'fail' | 'continue';
}

export interface WorkflowEdge {
  from_node: string;
  /** Defaults to 'out'. Producer node picks the port name (e.g. `true`/`false` for branch). */
  from_port?: string;
  to_node: string;
  /** Defaults to 'in'. Consumer node receives inputs keyed by this. */
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

export interface CronTriggerConfig {
  expression: string;           // standard cron syntax
  timezone: string;             // IANA tz (e.g. "America/Los_Angeles")
}

export interface EventTriggerConfig {
  event_type?: string;          // exact match; omit to match all types
  /** Equality matches on dotted-path fields in the event (e.g. {"payload.session_id": "abc"}). */
  filter?: Record<string, any>;
}

export type TriggerConfig = CronTriggerConfig | EventTriggerConfig | Record<string, never>;

export interface Trigger {
  trigger_id: string;
  workflow_id: string;
  type: TriggerType;
  enabled: boolean;
  config: TriggerConfig;
  /** "node" = synced from a `trigger` node on the canvas; "tab" (or missing)
   *  = authored via the side Triggers tab / REST API. Canvas-sync only
   *  touches source="node" triggers. */
  source?: 'node' | 'tab';
  /** When source=node, the id of the originating workflow node. */
  source_node_id?: string;
  created_at: string;
  updated_at: string;
}

export interface NodeState {
  status: NodeStatus;
  /** Resolved inputs handed to the executor. */
  input?: Record<string, any>;
  /** Port → value map produced by the executor. */
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
  /** Payload passed into the run (from the trigger firing or manual run). */
  input?: any;
  /** Session-level context propagated to all nodes. */
  context: {
    active_project_id?: string;
    trace_id?: string;
  };
  node_states: Record<string, NodeState>;
  output?: any;
  error?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

/* ── DTOs ──────────────────────────────────────────────────────────── */

export interface CreateWorkflowDto {
  name: string;
  description?: string;
  enabled?: boolean;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
}

export interface UpdateWorkflowDto extends Partial<CreateWorkflowDto> {}

export interface CreateTriggerDto {
  type: TriggerType;
  enabled?: boolean;
  config: TriggerConfig;
}

export interface RunWorkflowDto {
  input?: any;
  context?: Record<string, any>;
}
