/**
 * Workflows panel — three-pane layout:
 *   • left (220px):  workflow list
 *   • center (flex): React Flow canvas
 *   • right (320px): tabs (Node / Triggers / Runs)
 *
 * Unlike the other side-panels this one takes the full remaining width of
 * the viewport because a graph editor needs the room.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import axios from 'axios';
import {
  Workflow as WorkflowIcon, X, Plus, Play, Save, Loader2, Trash2, CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';

import { WorkflowCanvas } from './WorkflowCanvas';
import { NodeInspector } from './NodeInspector';
import { TriggersEditor } from './TriggersEditor';
import { RunsList } from './RunsList';
import { NODE_TYPES, type NodeStatus, type NodeType, type Workflow, type WorkflowEdge, type WorkflowNode } from './types';

const API = `${OASIS_BASE_URL}/api/v1/workflows`;

type RightTab = 'node' | 'triggers' | 'runs';

interface WorkflowsPanelProps {
  onClose: () => void;
}

export function WorkflowsPanel({ onClose }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>('node');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: NodeStatus; error?: string }>>({});
  const lastSavedVersion = useRef(0);

  const selected = useMemo(() => workflows.find(w => w.workflow_id === selectedId) || null, [workflows, selectedId]);

  const loadWorkflows = useCallback(async () => {
    try {
      const res = await axios.get(API);
      setWorkflows(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ } finally { setLoadingList(false); }
  }, []);

  useEffect(() => { loadWorkflows(); }, [loadWorkflows]);

  // When selection changes, load the draft copy
  useEffect(() => {
    if (!selected) { setDraft(null); setDirty(false); setSelectedNodeId(null); setNodeStatuses({}); return; }
    setDraft({ ...selected, nodes: [...selected.nodes], edges: [...selected.edges] });
    setDirty(false);
    lastSavedVersion.current = selected.version;
    setSelectedNodeId(null);
    setNodeStatuses({});
  }, [selected?.workflow_id, selected?.version]);

  const selectedNode = useMemo(
    () => draft?.nodes.find(n => n.id === selectedNodeId) ?? null,
    [draft, selectedNodeId],
  );

  /* ── Workflow list actions ───────────────────────────────────── */

  const createNew = useCallback(async () => {
    const name = prompt('Workflow name?', 'untitled');
    if (!name) return;
    try {
      const res = await axios.post(API, {
        name,
        nodes: [
          { id: 'in_1', type: 'input', position: { x: 80, y: 120 }, params: {} },
          { id: 'out_1', type: 'output', position: { x: 380, y: 120 }, params: {} },
        ],
        edges: [{ from_node: 'in_1', from_port: 'out', to_node: 'out_1', to_port: 'in' }],
      });
      await loadWorkflows();
      setSelectedId(res.data.workflow_id);
    } catch (err: any) {
      alert(`create failed: ${err?.response?.data?.message || err?.message}`);
    }
  }, [loadWorkflows]);

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    if (!confirm(`Delete workflow "${selected.name}"? Runs and triggers will be removed too.`)) return;
    try {
      await axios.delete(`${API}/${selected.workflow_id}`);
      setSelectedId(null);
      await loadWorkflows();
    } catch (err: any) {
      alert(`delete failed: ${err?.message}`);
    }
  }, [selected, loadWorkflows]);

  /* ── Draft editing ──────────────────────────────────────────── */

  const patchDraft = useCallback((patch: { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] }) => {
    setDraft(prev => prev ? { ...prev, ...patch } : prev);
    setDirty(true);
  }, []);

  const patchNode = useCallback((nodeId: string, p: Partial<WorkflowNode>) => {
    setDraft(prev => {
      if (!prev) return prev;
      return { ...prev, nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, ...p } : n) };
    });
    setDirty(true);
  }, []);

  const addNode = useCallback((type: NodeType) => {
    setDraft(prev => {
      if (!prev) return prev;
      // Simple unique id generator
      let i = 1;
      while (prev.nodes.some(n => n.id === `${type}_${i}`)) i++;
      const id = `${type}_${i}`;
      // Place near existing nodes' centroid
      const avgX = prev.nodes.length ? prev.nodes.reduce((a, n) => a + (n.position?.x || 0), 0) / prev.nodes.length : 200;
      const avgY = prev.nodes.length ? prev.nodes.reduce((a, n) => a + (n.position?.y || 0), 0) / prev.nodes.length : 200;
      const next: WorkflowNode = {
        id,
        type,
        position: { x: Math.round(avgX + 220), y: Math.round(avgY + 20) },
        params: defaultParams(type),
      };
      return { ...prev, nodes: [...prev.nodes, next] };
    });
    setDirty(true);
  }, []);

  const removeNode = useCallback((nodeId: string) => {
    setDraft(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: prev.nodes.filter(n => n.id !== nodeId),
        edges: prev.edges.filter(e => e.from_node !== nodeId && e.to_node !== nodeId),
      };
    });
    setDirty(true);
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  }, [selectedNodeId]);

  const save = useCallback(async () => {
    if (!draft || !selected) return;
    setSaving(true);
    try {
      await axios.patch(`${API}/${selected.workflow_id}`, {
        name: draft.name,
        description: draft.description,
        enabled: draft.enabled,
        nodes: draft.nodes,
        edges: draft.edges,
      });
      await loadWorkflows();
      setDirty(false);
    } catch (err: any) {
      alert(`save failed: ${err?.response?.data?.message || err?.message}`);
    } finally {
      setSaving(false);
    }
  }, [draft, selected, loadWorkflows]);

  const runNow = useCallback(async () => {
    if (!selected) return;
    setRunning(true);
    try {
      await axios.post(`${API}/${selected.workflow_id}/run`, {});
      setRightTab('runs');
    } catch (err: any) {
      alert(`run failed: ${err?.response?.data?.message || err?.message}`);
    } finally {
      setRunning(false);
    }
  }, [selected]);

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 'auto', opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="h-full border-r border-slate-800 bg-[#0a0f1a] flex overflow-hidden flex-1"
      style={{ minWidth: 0 }}
    >
      {/* ── Left: workflow list ── */}
      <div className="w-[220px] border-r border-slate-800 flex flex-col">
        <div className="p-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <WorkflowIcon className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-semibold text-slate-300">Workflows</span>
          </div>
          <Button size="sm" variant="ghost" className="h-6 text-[10px] text-violet-400 hover:text-violet-300" onClick={createNew}>
            <Plus className="w-3 h-3" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {loadingList && <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 text-violet-400 animate-spin" /></div>}
          {!loadingList && workflows.length === 0 && (
            <p className="text-[11px] text-slate-500 text-center py-6">No workflows yet.</p>
          )}
          {workflows.map(w => (
            <button
              key={w.workflow_id}
              className={cn(
                'w-full text-left p-2 rounded transition-colors text-xs',
                w.workflow_id === selectedId ? 'bg-violet-900/30 border border-violet-800/50' : 'hover:bg-slate-800/50',
              )}
              onClick={() => setSelectedId(w.workflow_id)}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-slate-200 truncate">{w.name}</span>
                {w.enabled && <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />}
              </div>
              {w.description && <div className="text-[10px] text-slate-500 line-clamp-1 mt-0.5">{w.description}</div>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Center: canvas ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-3 border-b border-slate-800 flex items-center gap-2">
          {selected ? (
            <>
              <input
                value={draft?.name ?? ''}
                onChange={e => { setDraft(prev => prev ? { ...prev, name: e.target.value } : prev); setDirty(true); }}
                className="text-sm font-semibold text-slate-200 bg-transparent border-b border-transparent hover:border-slate-800 focus:border-slate-700 outline-none px-1 min-w-[200px]"
              />
              <span className="text-[10px] text-slate-500 font-mono">v{selected.version}</span>
              {dirty && <span className="text-[10px] text-amber-400">• unsaved</span>}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" className="h-7 text-xs text-red-400 hover:text-red-300" onClick={deleteSelected}>
                <Trash2 className="w-3 h-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                Save
              </Button>
              <Button size="sm" className="h-7 text-xs bg-violet-700 hover:bg-violet-600 text-white" onClick={runNow} disabled={running}>
                {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
                Run
              </Button>
            </>
          ) : (
            <span className="text-xs text-slate-500">Select a workflow on the left, or click <kbd className="px-1 border border-slate-700 rounded text-[10px]">+</kbd> to create one.</span>
          )}
          <Button variant="ghost" size="icon" className="w-7 h-7 text-slate-400 hover:text-white ml-auto" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 relative" style={{ minHeight: 0 }}>
          {draft ? (
            <>
              <WorkflowCanvas
                workflow={draft}
                nodeStatuses={nodeStatuses}
                selectedNodeId={selectedNodeId}
                onSelectNode={(id) => { setSelectedNodeId(id); if (id) setRightTab('node'); }}
                onChange={patchDraft}
              />
              {/* Add-node palette pinned bottom-left */}
              <div className="absolute left-3 bottom-3 bg-slate-900/90 border border-slate-800 rounded p-2 flex flex-wrap gap-1 max-w-[360px]">
                {NODE_TYPES.map(t => (
                  <button
                    key={t}
                    onClick={() => addNode(t)}
                    className="text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono"
                  >
                    + {t}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-600 text-xs">
              no workflow selected
            </div>
          )}
        </div>
      </div>

      {/* ── Right: inspector tabs ── */}
      <div className="w-[320px] border-l border-slate-800 flex flex-col">
        <div className="flex border-b border-slate-800">
          {(['node', 'triggers', 'runs'] as RightTab[]).map(t => (
            <button
              key={t}
              onClick={() => setRightTab(t)}
              className={cn(
                'flex-1 text-[11px] py-2 border-b-2 transition-colors',
                rightTab === t ? 'border-violet-500 text-slate-200' : 'border-transparent text-slate-500 hover:text-slate-300',
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!selected ? (
            <p className="text-[11px] text-slate-500 p-3 text-center">Select a workflow to inspect.</p>
          ) : rightTab === 'node' ? (
            <NodeInspector
              node={selectedNode}
              allNodeIds={(draft?.nodes || []).map(n => n.id)}
              workflowId={selected?.workflow_id}
              onChange={(p) => selectedNode && patchNode(selectedNode.id, p)}
              onRemove={() => selectedNode && removeNode(selectedNode.id)}
            />
          ) : rightTab === 'triggers' ? (
            <TriggersEditor workflowId={selected.workflow_id} />
          ) : (
            <RunsList workflowId={selected.workflow_id} onNodeStatusesChange={setNodeStatuses} />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function defaultParams(type: NodeType): Record<string, any> {
  switch (type) {
    case 'trigger':   return { trigger_type: 'manual', enabled: true };
    case 'delay':     return { ms: 1000 };
    case 'transform': return { expression: 'value' };
    case 'filter':    return { expression: 'true' };
    case 'branch':    return { expression: 'true' };
    case 'http':      return { method: 'GET', url: 'https://example.com' };
    case 'mcp_tool':  return { tool_name: 'memory_query', arguments: { q: 'hello' } };
    default:          return {};
  }
}
