/**
 * Inspector for the currently-selected workflow node.
 *
 * Form view = per-node schema fields + arbitrary extra "attributes"
 *             (key/type/value rows) the user can add on top — useful for
 *             ad-hoc params the schema doesn't cover. Always visible below
 *             schema fields.
 *
 * JSON view = raw params editing, for pasting structured data verbatim.
 *
 * Field types supported by the form widgets:
 *   text | number | textarea | boolean | datetime | json | array
 *   cron (cron-builder widget) | trigger_type (cron|event|manual select)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Trash2, Check, Braces, FormInput, ChevronDown, Plus, X, Eye, Loader2, RefreshCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';
import type { WorkflowNode } from './types';
import {
  NODE_SCHEMAS, type FieldDef, type FieldType, variableSourcesFor,
} from './node-schemas';
import {
  CronBuilder, buildCron, stateFromExpression, defaultBuilderState,
  type CronBuilderState,
} from './cron-builder';
import { MediaPreview } from './MediaPreview';

const API = `${OASIS_BASE_URL}/api/v1/workflows`;

interface NodeInspectorProps {
  node: WorkflowNode | null;
  /** Full list of node IDs so the variable picker can offer upstream refs. */
  allNodeIds?: string[];
  /** When provided, the inspector fetches the latest run and shows this node's output as a live preview. */
  workflowId?: string;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove: () => void;
}

type Mode = 'form' | 'json';

export function NodeInspector({ node, allNodeIds, workflowId, onChange, onRemove }: NodeInspectorProps) {
  if (!node) {
    return (
      <div className="text-xs text-slate-500 p-3 text-center">
        Click a node on the canvas to edit its params.
      </div>
    );
  }
  return (
    <NodeInspectorInner
      key={node.id}
      node={node}
      allNodeIds={allNodeIds ?? []}
      workflowId={workflowId}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
}

function NodeInspectorInner({
  node, allNodeIds, workflowId, onChange, onRemove,
}: {
  node: WorkflowNode;
  allNodeIds: string[];
  workflowId?: string;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove: () => void;
}) {
  const schema = NODE_SCHEMAS[node.type];
  const [mode, setMode] = useState<Mode>('form');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // JSON-mode local state
  const [paramsText, setParamsText] = useState(() => JSON.stringify(node.params || {}, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  useEffect(() => {
    setParamsText(JSON.stringify(node.params || {}, null, 2));
    setJsonErr(null);
  }, [node.id, node.params]);

  const applyJson = () => {
    try {
      const parsed = JSON.parse(paramsText);
      setJsonErr(null);
      onChange({ params: parsed });
    } catch (e: any) {
      setJsonErr(e?.message || 'invalid JSON');
    }
  };

  const setField = (key: string, value: any) => {
    onChange({ params: { ...(node.params || {}), [key]: value } });
  };
  const deleteField = (key: string) => {
    const next = { ...(node.params || {}) };
    delete next[key];
    onChange({ params: next });
  };

  const advancedFields = (schema?.fields || []).filter(f => f.advanced);
  const primaryFields = (schema?.fields || []).filter(f => !f.advanced);
  const schemaKeys = useMemo(
    () => new Set((schema?.fields || []).map(f => f.key)),
    [schema],
  );
  const extraKeys = useMemo(
    () => Object.keys(node.params || {}).filter(k => !schemaKeys.has(k)),
    [node.params, schemaKeys],
  );

  /* ── Trigger-node-aware field filtering ── */
  // For trigger nodes: hide fields that don't apply to the selected kind
  // (cron fields when kind=event, etc.). Keeps the form compact.
  const filteredFields = (fields: FieldDef[]): FieldDef[] => {
    if (node.type !== 'trigger') return fields;
    const kind = (node.params || {}).trigger_type || 'manual';
    return fields.filter(f => {
      if (f.key === 'cron_expression' || f.key === 'cron_timezone') return kind === 'cron';
      if (f.key === 'event_type' || f.key === 'event_filter') return kind === 'event';
      return true;
    });
  };

  return (
    <div className="flex flex-col gap-2 p-3 text-xs text-slate-300">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="font-mono text-slate-400 truncate">{node.id}</div>
          <div className="text-[10px] text-slate-500 font-mono">type: {node.type}</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] text-red-400 hover:text-red-300 flex-shrink-0"
          onClick={onRemove}
        >
          <Trash2 className="w-3 h-3 mr-1" /> Remove
        </Button>
      </div>

      {schema?.description && (
        <p className="text-[11px] text-slate-500 leading-snug">{schema.description}</p>
      )}

      {/* ── Form/JSON toggle ── */}
      <div className="flex rounded border border-slate-800 overflow-hidden text-[10px] mt-1">
        <button
          onClick={() => setMode('form')}
          className={cn(
            'flex-1 py-1 flex items-center justify-center gap-1',
            mode === 'form' ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300',
          )}
        >
          <FormInput className="w-3 h-3" /> Form
        </button>
        <button
          onClick={() => setMode('json')}
          className={cn(
            'flex-1 py-1 flex items-center justify-center gap-1 border-l border-slate-800',
            mode === 'json' ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300',
          )}
        >
          <Braces className="w-3 h-3" /> JSON
        </button>
      </div>

      {/* ── Form view ── */}
      {mode === 'form' && (
        <div className="flex flex-col gap-2.5 mt-1">
          {filteredFields(primaryFields).map(f => (
            <FieldEditor
              key={f.key}
              field={f}
              value={(node.params || {})[f.key] ?? f.default ?? ''}
              onChange={v => setField(f.key, v)}
              allNodeIds={allNodeIds}
              currentNodeId={node.id}
            />
          ))}
          {filteredFields(advancedFields).length > 0 && (
            <>
              <button
                className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 self-start mt-1"
                onClick={() => setShowAdvanced(v => !v)}
              >
                <ChevronDown className={cn('w-3 h-3 transition-transform', !showAdvanced && '-rotate-90')} />
                Advanced
              </button>
              {showAdvanced && filteredFields(advancedFields).map(f => (
                <FieldEditor
                  key={f.key}
                  field={f}
                  value={(node.params || {})[f.key] ?? f.default ?? ''}
                  onChange={v => setField(f.key, v)}
                  allNodeIds={allNodeIds}
                  currentNodeId={node.id}
                />
              ))}
            </>
          )}

          {/* Generic attributes — always available */}
          <GenericAttributesEditor
            extraKeys={extraKeys}
            params={node.params || {}}
            onSetField={setField}
            onDeleteField={deleteField}
            allNodeIds={allNodeIds}
            currentNodeId={node.id}
          />
        </div>
      )}

      {/* ── JSON view ── */}
      {mode === 'json' && (
        <div className="flex flex-col gap-1.5 mt-1">
          <textarea
            value={paramsText}
            onChange={e => setParamsText(e.target.value)}
            rows={10}
            className="w-full text-[11px] text-slate-200 bg-slate-950/60 border border-slate-800 rounded p-2 font-mono resize-y"
            spellCheck={false}
          />
          <div className="flex items-center justify-between gap-2">
            <span className={cn('text-[10px]', jsonErr ? 'text-red-400' : 'text-slate-500')}>
              {jsonErr || 'Raw params JSON — supports `{{…}}` templates in string values.'}
            </span>
            <Button size="sm" className="h-7 text-xs" onClick={applyJson}>
              <Check className="w-3 h-3 mr-1" /> Apply
            </Button>
          </div>
        </div>
      )}

      {/* ── Last output preview (auto-detects media type) ── */}
      {workflowId && (
        <LastOutputSection workflowId={workflowId} nodeId={node.id} />
      )}

      {/* ── On-error policy (always present) ── */}
      <div className="mt-2 pt-2 border-t border-slate-800/60">
        <label className="text-[10px] text-slate-400">On error</label>
        <select
          value={node.on_error || 'fail'}
          onChange={e => onChange({ on_error: e.target.value as 'fail' | 'continue' })}
          className="text-[11px] bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 w-full mt-1"
        >
          <option value="fail">fail (default): stop the run</option>
          <option value="continue">continue: skip this node, keep going</option>
        </select>
      </div>
    </div>
  );
}

/* ── Last-output preview ────────────────────────────────────────── */

/**
 * Fetches the most recent run for this workflow and shows the selected
 * node's output rendered by `MediaPreview`. Collapsible; defaults open
 * if a rich media output is detected, collapsed for plain-text / json
 * fallbacks.
 */
function LastOutputSection({ workflowId, nodeId }: { workflowId: string; nodeId: string }) {
  const [loading, setLoading] = useState(true);
  const [output, setOutput] = useState<unknown>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(true);

  const fetchLatest = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${API}/${workflowId}/runs`, { params: { limit: 5 } });
      const runs = Array.isArray(res.data) ? res.data : [];
      // Pick the newest run where this node has a non-pending state.
      const matched = runs.find(r => {
        const st = r.node_states?.[nodeId];
        return st && st.status !== 'pending';
      });
      if (matched) {
        setRunId(matched.run_id);
        setStatus(matched.node_states[nodeId]?.status);
        setOutput(matched.node_states[nodeId]?.output);
      } else {
        setRunId(undefined);
        setStatus(undefined);
        setOutput(undefined);
      }
    } catch {
      // silently ignore; keep prior state
    } finally {
      setLoading(false);
    }
  }, [workflowId, nodeId]);

  useEffect(() => { fetchLatest(); }, [fetchLatest]);

  return (
    <div className="mt-2 pt-2 border-t border-slate-800/60">
      <div className="flex items-center justify-between">
        <button
          className="inline-flex items-center gap-1 text-[11px] text-slate-300 hover:text-slate-100"
          onClick={() => setOpen(v => !v)}
        >
          <Eye className="w-3 h-3" /> Last output
          {status && (
            <span className={cn(
              'ml-1 text-[10px] px-1 rounded border',
              status === 'completed' && 'text-emerald-300 border-emerald-800/50 bg-emerald-950/40',
              status === 'failed' && 'text-red-300 border-red-800/50 bg-red-950/40',
              status === 'skipped' && 'text-slate-400 border-slate-700',
              status === 'running' && 'text-purple-300 border-purple-800/50 bg-purple-950/40',
            )}>{status}</span>
          )}
          <ChevronDown className={cn('w-3 h-3 transition-transform', !open && '-rotate-90')} />
        </button>
        <button
          className="text-[10px] text-slate-500 hover:text-slate-300 inline-flex items-center gap-0.5"
          onClick={fetchLatest}
          disabled={loading}
          title="Refresh"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
        </button>
      </div>

      {open && (
        <div className="mt-2">
          {loading && !runId && (
            <p className="text-[10px] text-slate-500 italic">Loading latest run…</p>
          )}
          {!loading && runId === undefined && (
            <p className="text-[10px] text-slate-500 italic">No runs yet — hit Run to generate output.</p>
          )}
          {runId !== undefined && (
            <>
              <div className="text-[10px] text-slate-600 font-mono mb-1">run {runId.slice(0, 8)}…</div>
              <MediaPreview value={output} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Generic attributes editor ──────────────────────────────────── */

function GenericAttributesEditor({
  extraKeys, params, onSetField, onDeleteField, allNodeIds, currentNodeId,
}: {
  extraKeys: string[];
  params: Record<string, any>;
  onSetField: (key: string, value: any) => void;
  onDeleteField: (key: string) => void;
  allNodeIds: string[];
  currentNodeId: string;
}) {
  const [newKey, setNewKey] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');
  const [adding, setAdding] = useState(false);

  const addAttribute = () => {
    const k = newKey.trim();
    if (!k) return;
    if (k in params) return; // silent no-op if key exists
    const defaultValue: any = (() => {
      switch (newType) {
        case 'number':   return 0;
        case 'boolean':  return false;
        case 'array':    return [];
        case 'json':     return {};
        case 'datetime': return '';
        default:         return '';
      }
    })();
    onSetField(k, defaultValue);
    setNewKey('');
    setNewType('text');
    setAdding(false);
  };

  return (
    <div className="mt-2 pt-2 border-t border-slate-800/60 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-400">Extra attributes</span>
        <button
          className="inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300"
          onClick={() => setAdding(v => !v)}
        >
          <Plus className="w-3 h-3" /> Add attribute
        </button>
      </div>

      {extraKeys.length === 0 && !adding && (
        <p className="text-[10px] text-slate-500 italic">
          No extra attributes. Click "Add attribute" to define one.
        </p>
      )}

      {extraKeys.map(k => (
        <GenericAttributeRow
          key={k}
          name={k}
          value={params[k]}
          onChange={v => onSetField(k, v)}
          onDelete={() => onDeleteField(k)}
          allNodeIds={allNodeIds}
          currentNodeId={currentNodeId}
        />
      ))}

      {adding && (
        <div className="flex flex-col gap-1.5 p-2 rounded border border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-1.5">
            <input
              value={newKey}
              onChange={e => setNewKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              placeholder="key (snake_case)"
              className="flex-1 text-[11px] bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 font-mono"
              autoFocus
            />
            <TypeSelect value={newType} onChange={setNewType} />
            <Button size="sm" className="h-6 text-[10px]" onClick={addAttribute} disabled={!newKey.trim()}>
              <Check className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setAdding(false); setNewKey(''); }}>
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TypeSelect({ value, onChange }: { value: FieldType; onChange: (t: FieldType) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as FieldType)}
      className="text-[10px] bg-slate-900 border border-slate-800 rounded px-1 py-1 text-slate-200"
    >
      <option value="text">text</option>
      <option value="textarea">textarea</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
      <option value="datetime">datetime</option>
      <option value="array">array</option>
      <option value="json">json</option>
    </select>
  );
}

/**
 * One row of the generic attributes editor — inline key + type picker +
 * value widget. The type can be changed after creation; value is coerced /
 * reset when switching types to avoid impossible states.
 */
function GenericAttributeRow({
  name, value, onChange, onDelete, allNodeIds, currentNodeId,
}: {
  name: string;
  value: any;
  onChange: (v: any) => void;
  onDelete: () => void;
  allNodeIds: string[];
  currentNodeId: string;
}) {
  const inferred = inferFieldType(value);
  const [type, setType] = useState<FieldType>(inferred);

  useEffect(() => { setType(inferFieldType(value)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [name]);

  const onTypeChange = (next: FieldType) => {
    setType(next);
    // Coerce value to match the new type's defaults.
    switch (next) {
      case 'text':
      case 'textarea':
      case 'datetime':
        onChange(typeof value === 'string' ? value : value == null ? '' : String(value));
        break;
      case 'number':
        onChange(typeof value === 'number' ? value : Number(value) || 0);
        break;
      case 'boolean':
        onChange(Boolean(value));
        break;
      case 'array':
        onChange(Array.isArray(value) ? value : []);
        break;
      case 'json':
        onChange(value && typeof value === 'object' ? value : {});
        break;
    }
  };

  return (
    <div className="flex flex-col gap-1 p-2 rounded border border-slate-800 bg-slate-950/30">
      <div className="flex items-center gap-1.5">
        <code className="flex-1 text-[11px] text-slate-200 font-mono truncate">{name}</code>
        <TypeSelect value={type} onChange={onTypeChange} />
        <Button size="sm" variant="ghost" className="h-5 w-5 p-0 text-slate-500 hover:text-red-400" onClick={onDelete}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
      <FieldEditor
        field={{ key: name, label: '', type, interpolable: type === 'text' || type === 'textarea' }}
        value={value}
        onChange={onChange}
        allNodeIds={allNodeIds}
        currentNodeId={currentNodeId}
        /* Hide the label — the key row above already shows it. */
        hideLabel
      />
    </div>
  );
}

function inferFieldType(v: any): FieldType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'array';
  if (v && typeof v === 'object') return 'json';
  if (typeof v === 'string' && v.length > 80) return 'textarea';
  return 'text';
}

/* ── Field editor (typed widgets) ────────────────────────────────── */

function FieldEditor({
  field, value, onChange, allNodeIds, currentNodeId, hideLabel,
}: {
  field: FieldDef;
  value: any;
  onChange: (v: any) => void;
  allNodeIds: string[];
  currentNodeId: string;
  hideLabel?: boolean;
}) {
  const inputBase = 'w-full text-[11px] text-slate-200 bg-slate-950/60 border border-slate-800 rounded px-2 py-1';

  return (
    <div className="flex flex-col gap-1">
      {(!hideLabel || field.interpolable) && (
        <div className="flex items-baseline justify-between gap-2">
          {!hideLabel && (
            <label className="text-[11px] text-slate-300 font-medium">{field.label}</label>
          )}
          {field.interpolable && (
            <VariableChip
              allNodeIds={allNodeIds}
              currentNodeId={currentNodeId}
              onInsert={(expr) => {
                if (field.type === 'json') {
                  const cur = typeof value === 'string' ? value : JSON.stringify(value ?? '');
                  onChange(cur ? `${cur}${expr}` : expr);
                } else {
                  const cur = value == null ? '' : String(value);
                  onChange(cur ? `${cur}${expr}` : expr);
                }
              }}
            />
          )}
        </div>
      )}

      {field.type === 'text' && (
        <input
          type="text"
          value={value ?? ''}
          placeholder={field.placeholder}
          onChange={e => onChange(e.target.value)}
          className={inputBase}
        />
      )}

      {field.type === 'number' && (
        <input
          type="number"
          value={value ?? ''}
          onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={inputBase}
        />
      )}

      {field.type === 'textarea' && (
        <textarea
          value={value ?? ''}
          placeholder={field.placeholder}
          onChange={e => onChange(e.target.value)}
          rows={4}
          className={cn(inputBase, 'font-mono resize-y')}
          spellCheck={false}
        />
      )}

      {field.type === 'boolean' && (
        <button
          type="button"
          onClick={() => onChange(!value)}
          className={cn(
            'inline-flex items-center gap-1.5 self-start px-2 py-1 rounded border text-[11px]',
            value
              ? 'bg-emerald-900/30 border-emerald-800/50 text-emerald-300'
              : 'bg-slate-950/60 border-slate-800 text-slate-400',
          )}
        >
          <span
            className={cn(
              'inline-block w-3 h-3 rounded-full transition-colors',
              value ? 'bg-emerald-400' : 'bg-slate-600',
            )}
          />
          {value ? 'on' : 'off'}
        </button>
      )}

      {field.type === 'datetime' && (
        <input
          type="datetime-local"
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)}
          className={inputBase}
        />
      )}

      {field.type === 'json' && (
        <JsonField value={value} onChange={onChange} placeholder={field.placeholder} />
      )}

      {field.type === 'array' && (
        <ArrayField value={Array.isArray(value) ? value : []} onChange={onChange} />
      )}

      {field.type === 'cron' && (
        <CronFieldWrapper value={typeof value === 'string' ? value : '0 9 * * *'} onChange={onChange} />
      )}

      {field.type === 'trigger_type' && (
        <select
          value={value ?? 'manual'}
          onChange={e => onChange(e.target.value)}
          className={inputBase}
        >
          <option value="manual">manual (run-button only)</option>
          <option value="cron">cron (scheduled)</option>
          <option value="event">event (Oasis event match)</option>
        </select>
      )}

      {field.help && (
        <p className="text-[10px] text-slate-500 leading-snug">{field.help}</p>
      )}
    </div>
  );
}

function CronFieldWrapper({
  value, onChange,
}: {
  value: string;
  onChange: (expr: string) => void;
}) {
  const [state, setState] = useState<CronBuilderState>(() => stateFromExpression(value));
  // Keep internal state in sync if value is changed externally.
  useEffect(() => { setState(stateFromExpression(value)); }, [value]);

  return (
    <CronBuilder
      value={state}
      onChange={next => { setState(next); onChange(buildCron(next)); }}
    />
  );
}

function ArrayField({
  value, onChange,
}: {
  value: any[];
  onChange: (v: any[]) => void;
}) {
  const inputBase = 'w-full text-[11px] text-slate-200 bg-slate-950/60 border border-slate-800 rounded px-2 py-1';
  return (
    <div className="flex flex-col gap-1">
      {value.length === 0 && (
        <p className="text-[10px] text-slate-500 italic">Empty list.</p>
      )}
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            type="text"
            value={typeof item === 'string' ? item : JSON.stringify(item)}
            onChange={e => {
              const next = [...value];
              next[i] = e.target.value;
              onChange(next);
            }}
            className={cn(inputBase, 'font-mono')}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0 text-slate-500 hover:text-red-400"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, ''])}
        className="self-start inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300"
      >
        <Plus className="w-3 h-3" /> Add item
      </button>
    </div>
  );
}

function JsonField({
  value, onChange, placeholder,
}: {
  value: any;
  onChange: (v: any) => void;
  placeholder?: string;
}) {
  const initial = useMemo(() => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }, [value]);
  const [draft, setDraft] = useState(initial);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
    setErr(null);
  }, [initial]);

  const commit = () => {
    const s = draft.trim();
    if (/^\{\{[^}]+\}\}$/.test(s)) {
      onChange(s);
      setErr(null);
      return;
    }
    if (s === '') { onChange(undefined); setErr(null); return; }
    try {
      onChange(JSON.parse(s));
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || 'invalid JSON');
    }
  };

  return (
    <>
      <textarea
        value={draft}
        placeholder={placeholder ?? '{}'}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        rows={4}
        className="w-full text-[11px] text-slate-200 bg-slate-950/60 border border-slate-800 rounded px-2 py-1 font-mono resize-y"
        spellCheck={false}
      />
      {err && <p className="text-[10px] text-red-400">{err}</p>}
    </>
  );
}

function VariableChip({
  allNodeIds, currentNodeId, onInsert,
}: {
  allNodeIds: string[];
  currentNodeId: string;
  onInsert: (expression: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [childProp, setChildProp] = useState('');
  const sources = useMemo(
    () => variableSourcesFor({ allNodeIds, currentNodeId }),
    [allNodeIds, currentNodeId],
  );

  const insert = (expr: string) => {
    const cleaned = childProp.trim();
    if (!cleaned) {
      onInsert(expr);
    } else {
      const inner = expr.slice(2, -2).trim();
      onInsert(`{{${inner}.${cleaned.replace(/^\./, '')}}}`);
    }
    setOpen(false);
    setChildProp('');
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-violet-800/50 bg-violet-950/40 text-violet-300 hover:bg-violet-900/50"
        title="Insert a reference to an upstream value"
      >
        <Plus className="w-2.5 h-2.5" /> variable
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-10 w-60 bg-slate-900 border border-slate-800 rounded shadow-lg p-2 flex flex-col gap-1">
          <label className="text-[10px] text-slate-400">Optional child path</label>
          <input
            type="text"
            value={childProp}
            onChange={e => setChildProp(e.target.value)}
            placeholder="e.g. count  or  items.0.id"
            className="w-full text-[11px] bg-slate-950/60 border border-slate-800 rounded px-1.5 py-1 font-mono"
          />
          <div className="flex flex-col gap-0.5 mt-1 max-h-56 overflow-y-auto">
            {sources.map(s => (
              <button
                key={s.expression}
                onClick={() => insert(s.expression)}
                className="text-left text-[11px] px-1.5 py-1 rounded hover:bg-slate-800 text-slate-300 font-mono truncate"
                title={s.expression}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
