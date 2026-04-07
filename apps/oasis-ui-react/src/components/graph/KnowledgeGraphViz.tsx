import type { GraphData } from '@/lib/types';

// ── Tier definitions ─────────────────────────────────────────────────────
type Tier = 'foundational' | 'active';

const FOUNDATIONAL_TYPES = new Set([
  'ProblemNode', 'TriggerNode', 'EvidenceNode', 'ConstraintNode',
  'HypothesisNode', 'ConclusionNode', 'MemoryNode', 'ThoughtNode', 'ArtifactNode',
]);
const ACTIVE_TYPES = new Set([
  'GoalNode', 'PlanNode', 'ActionNode', 'CompletionNode',
]);

function inferTier(node: { node_type?: string; tier?: string }): Tier {
  if (node.tier === 'active' || node.tier === 'foundational') return node.tier;
  if (ACTIVE_TYPES.has(node.node_type || '')) return 'active';
  if (FOUNDATIONAL_TYPES.has(node.node_type || '')) return 'foundational';
  return 'foundational';
}

// ── Layout: foundational nodes on top, active on bottom ──────────────────
const FOUNDATIONAL_LAYER: Record<string, number> = {
  ProblemNode: 0, TriggerNode: 1, EvidenceNode: 1, ConstraintNode: 1,
  MemoryNode: 1, ArtifactNode: 1, HypothesisNode: 2, ConclusionNode: 3, ThoughtNode: 2,
};
const ACTIVE_LAYER: Record<string, number> = {
  GoalNode: 0, PlanNode: 1, ActionNode: 2, CompletionNode: 3,
};

function getNodeColor(nodeType: string): string {
  const colors: Record<string, string> = {
    ProblemNode: '#3b82f6', GoalNode: '#8b5cf6', TriggerNode: '#f59e0b', EvidenceNode: '#10b981',
    ConstraintNode: '#6366f1', HypothesisNode: '#ec4899', PlanNode: '#06b6d4', ActionNode: '#84cc16',
    ConclusionNode: '#22c55e', CompletionNode: '#14b8a6', MemoryNode: '#a855f7',
    ArtifactNode: '#f97316', ThoughtNode: '#94a3b8',
  };
  return colors[nodeType] || '#64748b';
}

// ── Tier section colors ──────────────────────────────────────────────────
const TIER_CONFIG: Record<Tier, { label: string; bg: string; border: string; text: string }> = {
  foundational: { label: 'Knowledge Base', bg: 'rgba(59, 130, 246, 0.04)', border: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa' },
  active:       { label: 'Active Steps',   bg: 'rgba(139, 92, 246, 0.04)', border: 'rgba(139, 92, 246, 0.15)', text: '#a78bfa' },
};

interface KnowledgeGraphVizProps {
  nodes: Array<{ id: string; node_type?: string; title?: string; tier?: string }>;
  edges: Array<{ source_node: string; target_node: string; edge_type?: string }>;
  hasGraphEntries: boolean;
  hasSelection: boolean;
  containerWidth?: number;
  containerHeight?: number;
}

export function KnowledgeGraphViz({
  nodes,
  edges,
  hasGraphEntries,
  hasSelection,
  containerWidth = 400,
  containerHeight,
}: KnowledgeGraphVizProps) {
  if (nodes.length === 0) {
    if (!hasGraphEntries) {
      return (
        <p className="text-[11px] text-slate-500 py-6 text-center">
          No reasoning graphs yet.<br />
          <span className="text-slate-600">Ask a complex question or use tools to see the knowledge graph.</span>
        </p>
      );
    }
    if (!hasSelection) {
      return (
        <p className="text-[11px] text-slate-500 py-6 text-center">
          Select a message above to view its reasoning graph.
        </p>
      );
    }
    return (
      <p className="text-[11px] text-slate-500 py-6 text-center">
        Empty graph for this message.<br />
        <span className="text-slate-600">Task graph may not have nodes yet, or planning failed.</span>
      </p>
    );
  }

  // ── Separate nodes by tier ──────────────────────────────────────────
  const foundationalNodes = nodes.filter(n => inferTier(n) === 'foundational');
  const activeNodes = nodes.filter(n => inferTier(n) === 'active');

  // ── Layout each tier section ────────────────────────────────────────
  const nodePositions: Record<string, { x: number; y: number }> = {};
  const layerH = 80;
  const nodeW = Math.min(140, Math.max(80, containerWidth / 6));
  const nodeH = 44;
  const width = containerWidth;
  const sectionGap = 40; // gap between foundational and active sections
  const sectionPad = 30; // top padding inside each section
  const labelH = 20; // space for section label

  function layoutSection(
    sectionNodes: typeof nodes,
    layerMap: Record<string, number>,
    yOffset: number,
  ): number {
    const layerGroups: Record<number, typeof nodes> = {};
    sectionNodes.forEach(n => {
      const layer = layerMap[n.node_type || ''] ?? 1;
      if (!layerGroups[layer]) layerGroups[layer] = [];
      layerGroups[layer].push(n);
    });
    const layerKeys = Object.keys(layerGroups).map(Number).sort((a, b) => a - b);
    layerKeys.forEach((layer, li) => {
      const layerNodes = layerGroups[layer];
      const count = layerNodes.length;
      const totalW = count * nodeW + (count - 1) * 20;
      const startX = (width - totalW) / 2 + nodeW / 2 + 10;
      layerNodes.forEach((n, i) => {
        nodePositions[n.id] = {
          x: startX + i * (nodeW + 20),
          y: yOffset + labelH + sectionPad + li * layerH,
        };
      });
    });
    return layerKeys.length * layerH + sectionPad + labelH;
  }

  let yPos = 10;
  const foundationalY = yPos;
  const foundationalH = foundationalNodes.length > 0
    ? layoutSection(foundationalNodes, FOUNDATIONAL_LAYER, yPos)
    : 0;

  yPos += foundationalH + (foundationalH > 0 ? sectionGap : 0);
  const activeY = yPos;
  const activeH = activeNodes.length > 0
    ? layoutSection(activeNodes, ACTIVE_LAYER, yPos)
    : 0;

  const totalHeight = containerHeight ?? Math.max(320, yPos + activeH + 30);

  // ── Section background rects ────────────────────────────────────────
  const sections: Array<{ tier: Tier; y: number; h: number; count: number }> = [];
  if (foundationalNodes.length > 0) sections.push({ tier: 'foundational', y: foundationalY, h: foundationalH, count: foundationalNodes.length });
  if (activeNodes.length > 0) sections.push({ tier: 'active', y: activeY, h: activeH, count: activeNodes.length });

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-auto" style={{ minHeight: 280 }}>
      <svg width={width} height={totalHeight} className="overflow-visible">
        <defs>
          <marker id="kg-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="rgba(100, 116, 139, 0.6)" />
          </marker>
        </defs>

        {/* Section backgrounds */}
        {sections.map(s => {
          const cfg = TIER_CONFIG[s.tier];
          return (
            <g key={`section-${s.tier}`}>
              <rect
                x={4} y={s.y} width={width - 8} height={s.h}
                rx={8} fill={cfg.bg} stroke={cfg.border}
                strokeWidth={1} strokeDasharray={s.tier === 'active' ? '4 3' : undefined}
              />
              <text x={12} y={s.y + 14} className="text-[10px] font-semibold" fill={cfg.text}>
                {cfg.label} ({s.count})
              </text>
            </g>
          );
        })}

        {/* Edges */}
        {edges.map((e, i) => {
          const src = nodePositions[e.source_node];
          const tgt = nodePositions[e.target_node];
          if (!src || !tgt) return null;
          const midY = (src.y + tgt.y) / 2;
          return (
            <g key={i}>
              <path
                d={`M ${src.x} ${src.y + nodeH / 2} C ${src.x} ${midY}, ${tgt.x} ${midY}, ${tgt.x} ${tgt.y - nodeH / 2}`}
                fill="none"
                stroke="rgba(100, 116, 139, 0.5)"
                strokeWidth={1.5}
                markerEnd="url(#kg-arrowhead)"
              />
              {e.edge_type && (
                <text x={(src.x + tgt.x) / 2} y={midY - 4} textAnchor="middle" className="fill-slate-500 text-[9px]" style={{ dominantBaseline: 'middle' }}>
                  {e.edge_type}
                </text>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map(n => {
          const pos = nodePositions[n.id] || { x: 0, y: 0 };
          const fill = getNodeColor(n.node_type || '');
          const tier = inferTier(n);
          return (
            <g key={n.id} transform={`translate(${pos.x - nodeW / 2}, ${pos.y - nodeH / 2})`}>
              <rect
                width={nodeW} height={nodeH} rx={8}
                fill={fill} fillOpacity={0.2}
                stroke={fill} strokeWidth={1.5}
                strokeDasharray={tier === 'active' ? '5 3' : undefined}
              />
              <text x={nodeW / 2} y={nodeH / 2} textAnchor="middle" className="fill-slate-200 text-[10px] font-medium" style={{ dominantBaseline: 'middle' }}>
                {(n.title || n.node_type || 'Node').slice(0, Math.max(14, Math.floor(nodeW / 8)))}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend: tiers + node types */}
      <div className="px-2 py-1.5 border-t border-slate-800/50">
        <div className="flex gap-3 mb-1">
          {sections.map(s => {
            const cfg = TIER_CONFIG[s.tier];
            return (
              <span key={s.tier} className="flex items-center gap-1 text-[9px]" style={{ color: cfg.text }}>
                <span className="inline-block w-2.5 h-2.5 rounded-sm border" style={{
                  backgroundColor: cfg.bg,
                  borderColor: cfg.border,
                  borderStyle: s.tier === 'active' ? 'dashed' : 'solid',
                }} />
                {cfg.label}
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1">
          {[...new Set(nodes.map(n => n.node_type || 'node'))].map(t => (
            <span key={t} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: `${getNodeColor(t)}33`, color: getNodeColor(t) }}>
              {t.replace('Node', '')}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
