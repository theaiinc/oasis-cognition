import { useMemo } from 'react';
import { Scale, Trash2 } from 'lucide-react';
import type { GraphData } from '@/lib/types';

interface RuleNode {
  id: string;
  condition?: string;
  conclusion?: string;
  confidence?: number;
}

interface RuleEdge {
  source: string;
  target: string;
  edge_type?: string;
  shared_concepts?: string[];
}

interface LogicEngineVizProps {
  memoryRules: Array<{ rule_id?: string; condition?: string; conclusion?: string; confidence?: number }>;
  rulesGraph: { nodes: RuleNode[]; edges: RuleEdge[] } | null;
  selectedData: GraphData | null;
  onDeleteRule?: (ruleId: string) => void;
  rulesStorageBackend?: string | null;
}

function getRuleColor(confidence: number): string {
  if (confidence >= 0.8) return '#22c55e';
  if (confidence >= 0.6) return '#f59e0b';
  if (confidence >= 0.4) return '#3b82f6';
  return '#64748b';
}

function getEdgeColor(edgeType: string): string {
  if (edgeType === 'DEPENDS_ON') return 'rgba(59, 130, 246, 0.6)';
  return 'rgba(100, 116, 139, 0.5)';
}

export function LogicEngineViz({ memoryRules, rulesGraph, selectedData, onDeleteRule, rulesStorageBackend }: LogicEngineVizProps) {
  const trace = selectedData?.reasoning_trace || [];
  const graph = selectedData?.graph as { nodes?: Array<{ node_type?: string; title?: string; description?: string }> } | undefined;
  const completionNode = graph?.nodes?.find((n) => n.node_type === 'CompletionNode');
  const conclusion =
    selectedData?.conclusion ??
    (completionNode
      ? completionNode.description
        ? `${completionNode.title || 'Goal'}: ${completionNode.description}`
        : completionNode.title
      : null);
  const confidence = selectedData?.confidence;

  const nodes = rulesGraph?.nodes || [];
  const edges = rulesGraph?.edges || [];
  /** Union list + graph nodes so we still show rules if one API path is empty/stale. */
  const rulesList = useMemo(() => {
    const byId = new Map<string, { rule_id?: string; condition?: string; conclusion?: string; confidence?: number }>();
    let anon = 0;
    const memKey = (r: { rule_id?: string }) => r.rule_id || `m-${anon++}`;
    for (const r of memoryRules) {
      byId.set(memKey(r), { ...r });
    }
    for (const n of nodes) {
      if (!n.id || byId.has(n.id)) continue;
      byId.set(n.id, {
        rule_id: n.id,
        condition: n.condition,
        conclusion: n.conclusion,
        confidence: n.confidence,
      });
    }
    return Array.from(byId.values());
  }, [memoryRules, nodes]);

  // Layout: arrange nodes in a force-directed-like grid
  const width = 420;
  const nodeW = 200;
  const nodeH = 72;
  const cols = Math.max(1, Math.min(2, Math.ceil(Math.sqrt(nodes.length))));
  const rowGap = 80;
  const colGap = 30;

  const nodePositions: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const totalColW = cols * nodeW + (cols - 1) * colGap;
    const startX = (width - totalColW) / 2 + nodeW / 2;
    nodePositions[n.id] = {
      x: startX + col * (nodeW + colGap),
      y: 40 + row * (nodeH + rowGap),
    };
  });

  const svgHeight = Math.max(200, Math.ceil(nodes.length / cols) * (nodeH + rowGap) + 40);

  return (
    <div className="space-y-4">
      {rulesStorageBackend === 'fallback' && (
        <p className="text-[10px] text-amber-400/90 bg-amber-950/40 border border-amber-800/50 rounded-md px-2 py-1.5 leading-snug">
          Memory service is using <strong>in-memory fallback</strong> (Neo4j unreachable at startup). Rules shown here are only what was stored in this process — not your Neo4j graph. Restart memory-service after Neo4j is healthy.
        </p>
      )}
      {selectedData && (
        <div className="space-y-2">
          <span className="text-[11px] font-medium text-slate-500 flex items-center gap-1"><Scale className="w-3 h-3" /> Decision</span>
          <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-[11px]">
            {conclusion && <p className="text-emerald-200 font-medium">{conclusion}</p>}
            {confidence != null && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${confidence * 100}%` }} />
                </div>
                <span className="text-slate-500">{(confidence * 100).toFixed(0)}%</span>
              </div>
            )}
          </div>
        </div>
      )}

      {trace.length > 0 && (
        <div className="space-y-2">
          <span className="text-[11px] font-medium text-slate-500">Reasoning trace</span>
          <div className="space-y-1">
            {trace.map((step, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="text-slate-600 text-[10px] mt-0.5 flex-shrink-0">{i + 1}.</span>
                <span className="text-[11px] text-slate-300">{step}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <span className="text-[11px] font-medium text-slate-500">
          Rules graph ({rulesList.length} rules, {edges.length} connections)
        </span>

        {nodes.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-auto" style={{ minHeight: 200 }}>
            <svg width={width} height={svgHeight} className="overflow-visible">
              <defs>
                <marker id="rule-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="rgba(100, 116, 139, 0.6)" />
                </marker>
                <marker id="rule-arrowhead-blue" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="rgba(59, 130, 246, 0.6)" />
                </marker>
              </defs>
              {edges.map((e, i) => {
                const src = nodePositions[e.source];
                const tgt = nodePositions[e.target];
                if (!src || !tgt) return null;
                const midY = (src.y + tgt.y) / 2;
                const edgeColor = getEdgeColor(e.edge_type || '');
                const markerId = e.edge_type === 'DEPENDS_ON' ? 'rule-arrowhead-blue' : 'rule-arrowhead';
                return (
                  <g key={i}>
                    <path
                      d={`M ${src.x} ${src.y + nodeH / 2} C ${src.x} ${midY}, ${tgt.x} ${midY}, ${tgt.x} ${tgt.y - nodeH / 2}`}
                      fill="none"
                      stroke={edgeColor}
                      strokeWidth={1.5}
                      markerEnd={`url(#${markerId})`}
                    />
                    {e.edge_type && (
                      <text x={(src.x + tgt.x) / 2} y={midY - 6} textAnchor="middle" className="fill-slate-600 text-[8px]" style={{ dominantBaseline: 'middle' }}>
                        {e.edge_type.replace('_', ' ').toLowerCase()}
                      </text>
                    )}
                  </g>
                );
              })}
              {nodes.map((n) => {
                const pos = nodePositions[n.id] || { x: 0, y: 0 };
                const fill = getRuleColor(n.confidence ?? 0.5);
                const condFull = n.condition || '—';
                const conclFull = n.conclusion || '—';
                const condText = condFull.length > 35 ? condFull.slice(0, 33) + '…' : condFull;
                const conclText = conclFull.length > 35 ? conclFull.slice(0, 33) + '…' : conclFull;
                return (
                  <g key={n.id} transform={`translate(${pos.x - nodeW / 2}, ${pos.y - nodeH / 2})`}>
                    <title>{`IF ${condFull}\nTHEN ${conclFull}\nConfidence: ${((n.confidence ?? 0.5) * 100).toFixed(0)}%`}</title>
                    <rect width={nodeW} height={nodeH} rx={8} fill={fill} fillOpacity={0.15} stroke={fill} strokeWidth={1.5} className="cursor-pointer hover:fill-opacity-25 transition-all" />
                    <text x={8} y={20} className="fill-amber-400/80 text-[9px] font-medium" style={{ pointerEvents: 'none' }}>
                      IF {condText}
                    </text>
                    <text x={8} y={38} className="fill-emerald-400/80 text-[9px] font-medium" style={{ pointerEvents: 'none' }}>
                      THEN {conclText}
                    </text>
                    <text x={nodeW - 8} y={58} textAnchor="end" className="fill-slate-500 text-[8px]" style={{ pointerEvents: 'none' }}>
                      {((n.confidence ?? 0.5) * 100).toFixed(0)}%
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="flex flex-wrap gap-1 mt-1 px-1 pb-1">
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: '#22c55e33', color: '#22c55e' }}>High (80%+)</span>
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: '#f59e0b33', color: '#f59e0b' }}>Medium (60%+)</span>
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: '#3b82f633', color: '#3b82f6' }}>Low (&lt;60%)</span>
              {edges.length > 0 && (
                <>
                  <span className="px-1.5 py-0.5 rounded text-[9px] text-slate-500 bg-slate-800">— supports</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] text-blue-400 bg-blue-900/30">→ depends on</span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="pt-3 space-y-2">
          <span className="text-[11px] font-medium text-slate-500">Rules list (delete/edit)</span>
        </div>

        {rulesList.length === 0 ? (
          <p className="text-[11px] text-slate-600">No rules yet. Teach the agent to add rules.</p>
        ) : (
          <div className="space-y-2 max-h-[400px] overflow-auto">
            {rulesList.map((r, i) => (
              <div key={r.rule_id || i} className="group px-3 py-2 rounded bg-slate-800/50 border border-slate-700/50 text-[11px] relative">
                <div className="mb-1">
                  <span className="text-amber-400/80 font-medium">IF</span>{' '}
                  <span className="text-slate-300">{r.condition || '—'}</span>
                </div>
                <div>
                  <span className="text-emerald-400/80 font-medium">THEN</span>{' '}
                  <span className="text-slate-300">{r.conclusion || '—'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  {r.confidence != null && (
                    <span className="text-slate-600 text-[10px]">Confidence: {(r.confidence * 100).toFixed(0)}%</span>
                  )}
                  {r.rule_id && onDeleteRule && (
                    <button
                      onClick={() => onDeleteRule(r.rule_id!)}
                      className="p-1 rounded hover:bg-red-950/40 text-slate-600 hover:text-red-400"
                      title="Delete rule"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
