/**
 * Single-renderer for every workflow node type. Keeps the React Flow
 * `nodeTypes` map small: one component whose look changes by `data.type`.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { NODE_TYPE_COLORS, type NodeStatus, type NodeType } from './types';
import {
  Play, CircleDot, Boxes, Globe, Timer, Shuffle, Filter, Wand2, Zap,
  CheckCircle2, XCircle, Loader2, Ban,
} from 'lucide-react';

export interface WorkflowNodeData {
  type: NodeType;
  label: string;
  params: Record<string, any>;
  status?: NodeStatus;
  error?: string;
}

const TYPE_ICON: Record<NodeType, typeof Play> = {
  trigger:   Zap,
  input:     Play,
  output:    CircleDot,
  mcp_tool:  Boxes,
  http:      Globe,
  delay:     Timer,
  branch:    Shuffle,
  filter:    Filter,
  transform: Wand2,
};

const STATUS_ICON: Record<NodeStatus, typeof CheckCircle2> = {
  pending:   CircleDot,
  running:   Loader2,
  completed: CheckCircle2,
  skipped:   Ban,
  failed:    XCircle,
};

export function WorkflowNodeRenderer({ data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  const Icon = TYPE_ICON[d.type] || CircleDot;
  // `trigger` and `input` are both graph entry points — they have no target
  // handle because the run's input flows into them from outside the graph.
  const isInput = d.type === 'input' || d.type === 'trigger';
  const isOutput = d.type === 'output';
  const hasTwoOutPorts = d.type === 'branch';

  return (
    <div
      className={cn(
        'rounded-lg border text-slate-200 px-3 py-2 min-w-[160px] shadow-md',
        NODE_TYPE_COLORS[d.type] || 'border-slate-500/50 bg-slate-900/40',
        selected && 'ring-1 ring-sky-400/70',
      )}
    >
      {/* ── Input port (all nodes except `input`) ── */}
      {!isInput && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="!w-2 !h-2 !bg-slate-400"
        />
      )}

      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate">{d.label || d.type}</div>
          <div className="text-[10px] text-slate-400 font-mono">{d.type}</div>
        </div>
        {d.status && (() => {
          const StatusIcon = STATUS_ICON[d.status];
          return (
            <StatusIcon className={cn(
              'w-3 h-3',
              d.status === 'running' && 'animate-spin text-purple-300',
              d.status === 'completed' && 'text-emerald-400',
              d.status === 'failed' && 'text-red-400',
              d.status === 'skipped' && 'text-slate-500',
            )} />
          );
        })()}
      </div>

      {d.error && (
        <div className="mt-1 text-[10px] text-red-300 truncate" title={d.error}>{d.error}</div>
      )}

      {/* ── Output port(s) ── */}
      {!isOutput && !hasTwoOutPorts && (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className="!w-2 !h-2 !bg-slate-400"
        />
      )}
      {hasTwoOutPorts && (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ top: '35%' }}
            className="!w-2 !h-2 !bg-emerald-400"
          >
            <span className="absolute -top-1 left-2 text-[9px] text-emerald-300">true</span>
          </Handle>
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ top: '70%' }}
            className="!w-2 !h-2 !bg-red-400"
          >
            <span className="absolute -top-1 left-2 text-[9px] text-red-300">false</span>
          </Handle>
        </>
      )}
    </div>
  );
}
