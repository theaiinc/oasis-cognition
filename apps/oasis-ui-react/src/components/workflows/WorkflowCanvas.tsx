/**
 * React Flow canvas for editing a workflow.
 *
 * The canvas owns the RF-internal node/edge state via `useNodesState` /
 * `useEdgesState` so measurements persist across renders (required by the
 * minimap). Changes bubble up to the parent via onChange with either a
 * nodes or edges patch.
 */

import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  type Connection, type Edge, type Node, type OnConnect, type NodeChange, type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { WorkflowNodeRenderer } from './WorkflowNodeRenderer';
import type { NodeStatus, Workflow, WorkflowEdge, WorkflowNode } from './types';

interface WorkflowCanvasProps {
  workflow: Workflow;
  nodeStatuses?: Record<string, { status: NodeStatus; error?: string }>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onChange: (patch: { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] }) => void;
}

// Custom key (not "default") — React Flow's built-in `default` type ships its
// own white chrome and layering BOTH breaks the visuals.
const NODE_KIND = 'oasis';
const nodeTypes = { [NODE_KIND]: WorkflowNodeRenderer };

function wfToRfNodes(
  wf: Workflow,
  statuses: Record<string, { status: NodeStatus; error?: string }> | undefined,
): Node[] {
  return (wf.nodes || []).map((n, i) => ({
    id: n.id,
    type: NODE_KIND,
    position: n.position ?? { x: 100 + i * 220, y: 140 + (i % 3) * 110 },
    // Explicit dimensions so React Flow v12's MiniMap has something to
    // render before the ResizeObserver first fires. The canvas still lets
    // the renderer auto-size visually — these are just hints.
    width: 180,
    height: 56,
    data: {
      type: n.type,
      label: n.params?.label || n.type,
      params: n.params || {},
      status: statuses?.[n.id]?.status,
      error: statuses?.[n.id]?.error,
    },
  }));
}

function wfToRfEdges(
  wf: Workflow,
  statuses: Record<string, { status: NodeStatus; error?: string }> | undefined,
): Edge[] {
  return (wf.edges || []).map((e, i) => ({
    id: `e${i}-${e.from_node}-${e.to_node}-${e.from_port || 'out'}-${e.to_port || 'in'}`,
    source: e.from_node,
    target: e.to_node,
    sourceHandle: e.from_port || 'out',
    targetHandle: e.to_port || 'in',
    animated: statuses?.[e.from_node]?.status === 'running',
    style: { stroke: '#94a3b8' },
  }));
}

function Canvas({
  workflow, nodeStatuses, selectedNodeId, onSelectNode, onChange,
}: WorkflowCanvasProps) {
  const initialNodes = useMemo(() => wfToRfNodes(workflow, nodeStatuses), [workflow, nodeStatuses]);
  const initialEdges = useMemo(() => wfToRfEdges(workflow, nodeStatuses), [workflow, nodeStatuses]);

  // RF-internal state (preserves measured dimensions → minimap works).
  const [nodes, setNodes, onNodesChangeRF] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChangeRF] = useEdgesState(initialEdges);

  // Re-sync internal state when workflow structure changes (parent committed
  // an edit, a remote update landed, etc.). Position/measured dimensions are
  // preserved because we re-use objects by id where possible.
  useEffect(() => {
    setNodes(prev => {
      const byId = new Map(prev.map(n => [n.id, n] as const));
      return initialNodes.map(n => {
        const old = byId.get(n.id);
        return old
          ? { ...n, position: old.position, measured: (old as any).measured }
          : n;
      });
    });
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  // Apply selection highlight based on external prop
  useEffect(() => {
    setNodes(ns => ns.map(n => (n.selected === (n.id === selectedNodeId)
      ? n
      : { ...n, selected: n.id === selectedNodeId })));
  }, [selectedNodeId, setNodes]);

  /* ── Change propagation ─────────────────────────────────────── */

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChangeRF(changes);
    // After RF has applied changes locally, push structural changes (remove,
    // position-drag-end) up to the parent workflow draft.
    const removed = changes.filter(c => c.type === 'remove') as Array<{ type: 'remove'; id: string }>;
    if (removed.length > 0) {
      const removedIds = new Set(removed.map(r => r.id));
      const nextNodes = (workflow.nodes || []).filter(n => !removedIds.has(n.id));
      const nextEdges = (workflow.edges || []).filter(e => !removedIds.has(e.from_node) && !removedIds.has(e.to_node));
      onChange({ nodes: nextNodes, edges: nextEdges });
      return;
    }

    const positionChanged = changes.find(c => c.type === 'position' && (c as any).dragging === false) as
      { type: 'position'; id: string; position?: { x: number; y: number } } | undefined;
    if (positionChanged?.position) {
      const nextNodes = (workflow.nodes || []).map(n =>
        n.id === positionChanged.id
          ? { ...n, position: { x: Math.round(positionChanged.position!.x), y: Math.round(positionChanged.position!.y) } }
          : n,
      );
      onChange({ nodes: nextNodes });
    }

    const selectChange = changes.find(c => c.type === 'select') as { id: string; selected: boolean } | undefined;
    if (selectChange) {
      onSelectNode(selectChange.selected ? selectChange.id : null);
    }
  }, [onNodesChangeRF, workflow.nodes, workflow.edges, onChange, onSelectNode]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChangeRF(changes);
    const removed = changes.filter(c => c.type === 'remove') as Array<{ type: 'remove'; id: string }>;
    if (removed.length > 0) {
      const keepIds = new Set(edges.filter(e => !removed.some(r => r.id === e.id)).map(e => e.id));
      const nextEdges = (workflow.edges || []).filter((_, i) => {
        const id = `e${i}-${workflow.edges[i].from_node}-${workflow.edges[i].to_node}-${workflow.edges[i].from_port || 'out'}-${workflow.edges[i].to_port || 'in'}`;
        return keepIds.has(id);
      });
      onChange({ edges: nextEdges });
    }
  }, [onEdgesChangeRF, edges, workflow.edges, onChange]);

  const onConnect: OnConnect = useCallback((conn: Connection) => {
    const newEdge: WorkflowEdge = {
      from_node: conn.source!,
      from_port: conn.sourceHandle || 'out',
      to_node: conn.target!,
      to_port: conn.targetHandle || 'in',
    };
    const exists = (workflow.edges || []).some(e =>
      e.from_node === newEdge.from_node && (e.from_port || 'out') === newEdge.from_port &&
      e.to_node === newEdge.to_node && (e.to_port || 'in') === newEdge.to_port);
    if (!exists) {
      onChange({ edges: [...(workflow.edges || []), newEdge] });
      // Also update RF state so the edge appears immediately
      setEdges(es => addEdge({
        source: newEdge.from_node,
        target: newEdge.to_node,
        sourceHandle: newEdge.from_port,
        targetHandle: newEdge.to_port,
      } as Connection, es));
    }
  }, [workflow.edges, onChange, setEdges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => onSelectNode(null)}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ style: { stroke: '#94a3b8' } }}
    >
      <Background color="#1e293b" gap={16} />
      {/* Controls sit at bottom-left but raised above the node palette
          (which pins to left:12, bottom:12 and is ~170px tall). */}
      <Controls
        position="bottom-left"
        style={{ bottom: 200 }}
        className="!bg-slate-900 !border-slate-800 [&>button]:!bg-slate-900 [&>button]:!border-slate-800 [&>button]:!text-slate-300 [&>button]:hover:!bg-slate-800"
      />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={(n) => {
          const t = (n.data as { type?: string })?.type;
          switch (t) {
            case 'trigger':   return '#f59e0b';
            case 'input':     return '#38bdf8';
            case 'output':    return '#34d399';
            case 'mcp_tool':  return '#c084fc';
            case 'http':      return '#fb923c';
            case 'delay':     return '#94a3b8';
            case 'branch':    return '#fbbf24';
            case 'filter':    return '#fbbf24';
            case 'transform': return '#60a5fa';
            default:          return '#94a3b8';
          }
        }}
        nodeStrokeColor="#0f172a"
        nodeStrokeWidth={2}
        nodeBorderRadius={4}
        maskColor="rgba(15, 23, 42, 0.65)"
        maskStrokeColor="#475569"
        maskStrokeWidth={1}
        style={{ width: 180, height: 120 }}
        className="!bg-slate-950 !border !border-slate-800 rounded"
      />
    </ReactFlow>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
