/**
 * Per-node-type parameter schemas used by the Form view of NodeInspector.
 *
 * Each field describes how to render an input widget:
 *   • text        → single-line <input>
 *   • textarea    → multi-line <textarea>
 *   • number      → <input type="number">
 *   • boolean     → toggle switch
 *   • datetime    → HTML datetime-local picker
 *   • json        → JSON-edited textarea (parsed on save)
 *
 * `interpolable: true` fields get a "variable picker" chip that inserts
 * `{{nodes.<nodeId>.out}}` / `{{input}}` etc. — the same template syntax the
 * engine's interpolator already understands.
 */

import type { NodeType } from './types';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'array'           // list of strings (ad-hoc rows)
  | 'cron'            // full cron-builder widget
  | 'trigger_type';   // cron | event | manual select

export interface FieldDef {
  key: string;               // maps to node.params[key]
  label: string;
  type: FieldType;
  /** Help text shown below the input. */
  help?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** If true, field accepts `{{…}}` template expressions — we show a picker. */
  interpolable?: boolean;
  /** Initial value when the field is absent. */
  default?: any;
  /** Rendered before any other fields. */
  advanced?: boolean;
}

export interface NodeSchema {
  fields: FieldDef[];
  /** Short human-readable description of what this node does. */
  description?: string;
}

const EXPRESSION_HELP =
  'JEXL expression. Identifiers: `value` (default input port), `inputs["in"]`, `nodes.<id>.out`, `input`, `context`. Transforms: | length | json | keys | lower | upper.';

export const NODE_SCHEMAS: Record<NodeType, NodeSchema> = {
  input: {
    description: 'Entry point — emits the run input on its `out` port.',
    fields: [],
  },
  output: {
    description: 'Terminal sink — whatever arrives on its `in` port becomes the run output.',
    fields: [],
  },
  trigger: {
    description: 'Visual entry point. Configure its kind — cron schedule, Oasis event, or manual — and the workflow engine will sync the actual Trigger record when you save.',
    fields: [
      { key: 'trigger_type', label: 'Kind', type: 'trigger_type', default: 'manual' },
      { key: 'cron_expression', label: 'Schedule', type: 'cron', default: '0 9 * * *', help: 'Only used when kind = cron.' },
      { key: 'cron_timezone', label: 'Timezone (IANA)', type: 'text', default: 'UTC', placeholder: 'America/Los_Angeles', help: 'Only used when kind = cron.' },
      { key: 'event_type', label: 'Event type', type: 'text', placeholder: 'FeedbackReceived', help: 'Only used when kind = event. Leave blank to match any type.' },
      { key: 'event_filter', label: 'Event filter', type: 'json', default: {}, help: 'Only used when kind = event. Dotted-path equality match, e.g. {"payload.session_id":"abc"}.' },
      { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
    ],
  },
  delay: {
    description: 'Pause the pipeline for a fixed duration before passing input through.',
    fields: [
      { key: 'ms', label: 'Delay (milliseconds)', type: 'number', default: 1000, help: 'Milliseconds to wait.' },
    ],
  },
  branch: {
    description: 'Route the input to the `true` or `false` output port based on a JEXL expression.',
    fields: [
      { key: 'expression', label: 'Condition', type: 'textarea', default: 'value != null', help: EXPRESSION_HELP, interpolable: false },
    ],
  },
  filter: {
    description: 'Pass the input through only if the expression is truthy — else downstream is skipped.',
    fields: [
      { key: 'expression', label: 'Condition', type: 'textarea', default: 'true', help: EXPRESSION_HELP },
    ],
  },
  transform: {
    description: 'Reshape the input. Output of the JEXL expression becomes this node’s `out`.',
    fields: [
      { key: 'expression', label: 'Expression', type: 'textarea', default: 'value', help: EXPRESSION_HELP },
    ],
  },
  http: {
    description: 'Generic HTTP request.',
    fields: [
      { key: 'method', label: 'Method', type: 'text', default: 'GET' },
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com/thing', interpolable: true },
      { key: 'headers', label: 'Headers', type: 'json', default: {}, help: 'JSON map of header → value.' },
      { key: 'body', label: 'Body', type: 'json', default: null, help: 'JSON body (or null). Supports `{{…}}` templates.', interpolable: true, advanced: true },
      { key: 'timeout_ms', label: 'Timeout (ms)', type: 'number', default: 30000, advanced: true },
    ],
  },
  mcp_tool: {
    description: 'Call any tool on the Oasis MCP server.',
    fields: [
      { key: 'tool_name', label: 'Tool name', type: 'text', placeholder: 'memory_query', help: 'e.g. cu_list_sessions, agent_spawn, memory_query.' },
      { key: 'arguments', label: 'Arguments', type: 'json', default: {}, help: 'JSON object. `{{…}}` templates are resolved at dispatch time.', interpolable: true },
      { key: 'parse_json', label: 'Parse result as JSON', type: 'boolean', default: true, advanced: true },
      { key: 'server', label: 'MCP server URL', type: 'text', placeholder: '(default: Oasis MCP)', advanced: true },
    ],
  },
};

/* ── Variable picker sources ───────────────────────────────────────── */

export interface VariableSource {
  label: string;
  /** The template expression to insert. */
  expression: string;
}

/**
 * Enumerate the upstream references a node can use, given the whole workflow
 * and the currently-selected node id. Returns a flat list of "variable
 * suggestions" the UI renders as chips.
 *
 * Sources include:
 *   • Workflow input            → `{{input}}` and `{{input.<prop>}}`
 *   • Each upstream node's out  → `{{nodes.<id>.out}}` and `{{nodes.<id>.out.<prop>}}`
 *   • This node's own inputs    → `{{value}}` (the default port)
 *
 * The list is deliberately simple — no child-property discovery (we don't
 * know their shapes at design time). A free-text "child property" suffix
 * input on the chip lets the user append `.foo.bar` themselves.
 */
export function variableSourcesFor(params: {
  allNodeIds: string[];
  currentNodeId: string;
}): VariableSource[] {
  const out: VariableSource[] = [];
  out.push({ label: 'workflow.input', expression: '{{input}}' });
  out.push({ label: 'this.value (default in)', expression: '{{value}}' });
  for (const id of params.allNodeIds) {
    if (id === params.currentNodeId) continue;
    out.push({ label: `${id}.out`, expression: `{{nodes.${id}.out}}` });
  }
  return out;
}
