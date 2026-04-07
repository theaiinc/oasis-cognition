import { useState, useMemo } from 'react';
import type { CodeGraphData } from '@/lib/types';

const NODE_LAYER: Record<string, number> = {
  CodeFile: 0,
  class: 1, interface: 1,
  function: 2, method: 2,
  variable: 3, const: 3, enum: 3,
};

function getNodeColor(nodeType: string): string {
  const colors: Record<string, string> = {
    CodeFile: '#64748b',
    class: '#a855f7',
    interface: '#8b5cf6',
    function: '#06b6d4',
    method: '#22d3ee',
    variable: '#22c55e',
    const: '#10b981',
    enum: '#84cc16',
  };
  return colors[nodeType] || '#64748b';
}

const EDGE_COLORS: Record<string, string> = {
  CONTAINS: 'rgba(100,116,139,0.5)',
  IMPORTS: '#f59e0b',
  CALLS: '#3b82f6',
  EXTENDS: '#a855f7',
  IMPLEMENTS: '#8b5cf6',
};

interface CodeGraphVizProps {
  data: CodeGraphData;
}

export function CodeGraphViz({ data }: CodeGraphVizProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    const matchedNodes = data.nodes.filter(
      (n) => n.label.toLowerCase().includes(q) || n.node_type.toLowerCase().includes(q),
    );
    const ids = new Set(matchedNodes.map((n) => n.id));
    // Include connected nodes one hop away
    data.edges.forEach((e) => {
      if (ids.has(e.source)) ids.add(e.target);
      if (ids.has(e.target)) ids.add(e.source);
    });
    const expandedNodes = data.nodes.filter((n) => ids.has(n.id));
    const filteredEdges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes: expandedNodes, edges: filteredEdges, stats: data.stats };
  }, [data, search]);

  const nodes = filtered.nodes;
  const edges = filtered.edges;

  if (data.nodes.length === 0) {
    return (
      <p className="text-[11px] text-slate-500 py-6 text-center">
        No code graph data available.<br />
        <span className="text-slate-600">Index your workspace to populate the code knowledge graph.</span>
      </p>
    );
  }

  // Layout
  const width = 380;
  const layerGroups: Record<number, typeof nodes> = {};
  nodes.forEach((n) => {
    const layer = NODE_LAYER[n.node_type] ?? 2;
    if (!layerGroups[layer]) layerGroups[layer] = [];
    layerGroups[layer].push(n);
  });

  const nodeW = 120;
  const nodeH = 36;
  const layerH = 80;
  const nodePositions: Record<string, { x: number; y: number }> = {};

  const sortedLayers = Object.keys(layerGroups).map(Number).sort((a, b) => a - b);
  sortedLayers.forEach((layer, layerIdx) => {
    const layerNodes = layerGroups[layer];
    const count = layerNodes.length;
    const gap = 16;
    const totalW = count * nodeW + (count - 1) * gap;
    const startX = Math.max(nodeW / 2 + 4, (width - totalW) / 2 + nodeW / 2);
    layerNodes.forEach((n, i) => {
      nodePositions[n.id] = {
        x: startX + i * (nodeW + gap),
        y: 44 + layerIdx * layerH,
      };
    });
  });

  const svgHeight = Math.max(280, sortedLayers.length * layerH + 80);
  const svgWidth = Math.max(width, nodes.length * 40);

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search symbols..."
        className="w-full px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
      />
      <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-auto" style={{ minHeight: 200 }}>
        <svg width={svgWidth} height={svgHeight} className="overflow-visible">
          <defs>
            <marker id="cg-arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="rgba(100,116,139,0.6)" />
            </marker>
            {Object.entries(EDGE_COLORS).map(([rel, color]) => (
              <marker key={rel} id={`cg-arrow-${rel}`} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={color} />
              </marker>
            ))}
          </defs>
          {edges.map((e, i) => {
            const src = nodePositions[e.source];
            const tgt = nodePositions[e.target];
            if (!src || !tgt) return null;
            const midY = (src.y + tgt.y) / 2;
            const color = EDGE_COLORS[e.rel] || 'rgba(100,116,139,0.5)';
            const markerId = EDGE_COLORS[e.rel] ? `cg-arrow-${e.rel}` : 'cg-arrowhead';
            return (
              <g key={i}>
                <path
                  d={`M ${src.x} ${src.y + nodeH / 2} C ${src.x} ${midY}, ${tgt.x} ${midY}, ${tgt.x} ${tgt.y - nodeH / 2}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.2}
                  markerEnd={`url(#${markerId})`}
                />
              </g>
            );
          })}
          {nodes.map((n) => {
            const pos = nodePositions[n.id];
            if (!pos) return null;
            const fill = getNodeColor(n.node_type);
            return (
              <g key={n.id} transform={`translate(${pos.x - nodeW / 2}, ${pos.y - nodeH / 2})`}>
                <title>{`${n.node_type}: ${n.label}${n.file_path ? `\n${n.file_path}` : ''}${n.line ? `:${n.line}` : ''}`}</title>
                <rect width={nodeW} height={nodeH} rx={6} fill={fill} fillOpacity={0.15} stroke={fill} strokeWidth={1.2} />
                <text x={nodeW / 2} y={nodeH / 2} textAnchor="middle" className="fill-slate-200 text-[9px] font-medium" style={{ dominantBaseline: 'middle' }}>
                  {n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(EDGE_COLORS).map(([rel, color]) => (
          <span key={rel} className="flex items-center gap-1 text-[9px] text-slate-400">
            <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: color }} />
            {rel}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {[...new Set(data.nodes.map((n) => n.node_type))].map((t) => (
          <span key={t} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: `${getNodeColor(t)}33`, color: getNodeColor(t) }}>{t}</span>
        ))}
      </div>
    </div>
  );
}
