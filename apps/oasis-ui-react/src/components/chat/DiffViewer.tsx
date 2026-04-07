import { useState } from 'react';
import { GitBranch, ChevronDown, ChevronRight } from 'lucide-react';

interface DiffViewerProps {
  diff: string;
  filesChanged: string[];
  worktreeId: string;
  onApply: (worktreeId: string) => void;
  onDiscard: (worktreeId: string) => void;
}

export function DiffViewer({ diff, filesChanged, worktreeId, onApply, onDiscard }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(true);
  const [applying, setApplying] = useState(false);
  const lines = diff.split('\n');

  return (
    <div className="rounded-xl border border-blue-800/50 bg-slate-950 overflow-hidden my-2">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-sm font-medium text-blue-300 hover:text-blue-200"
        >
          <GitBranch className="w-4 h-4" />
          <span>{filesChanged.length} file{filesChanged.length !== 1 ? 's' : ''} changed</span>
          <span className="text-[10px] text-slate-500 font-mono">({worktreeId})</span>
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setApplying(true);
              onApply(worktreeId);
            }}
            disabled={applying}
            className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            {applying ? 'Applying...' : '✓ Apply'}
          </button>
          <button
            type="button"
            onClick={() => onDiscard(worktreeId)}
            className="px-3 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium transition-colors"
          >
            ✕ Discard
          </button>
        </div>
      </div>

      {expanded && filesChanged.length > 0 && (
        <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/50">
          {filesChanged.map((f, i) => {
            const parts = f.split('\t');
            const status = parts[0];
            const fname = parts[parts.length - 1];
            const statusColor = status === 'A' ? 'text-emerald-400' : status === 'D' ? 'text-red-400' : 'text-amber-400';
            return (
              <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                <span className={`font-mono font-bold ${statusColor}`}>{status}</span>
                <span className="text-slate-300 font-mono">{fname}</span>
              </div>
            );
          })}
        </div>
      )}

      {expanded && diff && (
        <div className="overflow-x-auto max-h-[240px] overflow-y-auto">
          <pre className="text-[12px] leading-5 font-mono p-0">
            {lines.map((line, i) => {
              let cls = 'text-slate-400 px-4';
              if (line.startsWith('+') && !line.startsWith('+++')) {
                cls = 'text-emerald-300 bg-emerald-950/40 px-4';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                cls = 'text-red-300 bg-red-950/40 px-4';
              } else if (line.startsWith('@@')) {
                cls = 'text-blue-400 bg-blue-950/30 px-4 font-semibold';
              } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
                cls = 'text-slate-500 px-4';
              }
              return <div key={i} className={cls}>{line || ' '}</div>;
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
