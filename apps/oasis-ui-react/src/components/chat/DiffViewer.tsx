import { useMemo, useState } from 'react';
import { GitBranch, ChevronDown, ChevronRight, Columns2, AlignLeft } from 'lucide-react';

interface DiffViewerProps {
  diff: string;
  filesChanged: string[];
  worktreeId: string;
  onApply: (worktreeId: string) => void;
  onDiscard: (worktreeId: string) => void;
}

type SplitRow =
  | { kind: 'context'; oldNo: number; newNo: number; text: string }
  | { kind: 'change'; oldNo: number | null; newNo: number | null; oldText: string; newText: string }
  | { kind: 'hunk'; header: string };

interface ParsedFile {
  header: string;
  oldPath: string;
  newPath: string;
  rows: SplitRow[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseSplitDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;

  // Buffers for pairing consecutive removals/additions into change rows.
  let pendingDel: { no: number; text: string }[] = [];
  let pendingAdd: { no: number; text: string }[] = [];
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (!current) return;
    const max = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < max; i++) {
      const d = pendingDel[i];
      const a = pendingAdd[i];
      current.rows.push({
        kind: 'change',
        oldNo: d ? d.no : null,
        newNo: a ? a.no : null,
        oldText: d ? d.text : '',
        newText: a ? a.text : '',
      });
    }
    pendingDel = [];
    pendingAdd = [];
  };

  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const parts = line.split(' ');
      const a = parts[2]?.replace(/^a\//, '') ?? '';
      const b = parts[3]?.replace(/^b\//, '') ?? '';
      current = { header: line, oldPath: a, newPath: b, rows: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ')) {
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      flush();
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[3], 10);
      current.rows.push({ kind: 'hunk', header: line });
      continue;
    }
    if (line.startsWith('+')) {
      pendingAdd.push({ no: newNo, text: line.slice(1) });
      newNo++;
      continue;
    }
    if (line.startsWith('-')) {
      pendingDel.push({ no: oldNo, text: line.slice(1) });
      oldNo++;
      continue;
    }
    // Context line (starts with space, or empty)
    flush();
    const text = line.startsWith(' ') ? line.slice(1) : line;
    current.rows.push({ kind: 'context', oldNo, newNo, text });
    oldNo++;
    newNo++;
  }
  flush();

  // Drop empty files (e.g. binary diffs gave us only headers)
  return files.filter((f) => f.rows.length > 0);
}

export function DiffViewer({ diff, filesChanged, worktreeId, onApply, onDiscard }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(true);
  const [applying, setApplying] = useState(false);
  const [mode, setMode] = useState<'split' | 'unified'>('split');

  const parsed = useMemo(() => (mode === 'split' ? parseSplitDiff(diff) : []), [diff, mode]);
  const unifiedLines = useMemo(() => (mode === 'unified' ? diff.split('\n') : []), [diff, mode]);

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
          <div className="flex items-center rounded-lg bg-slate-800 p-0.5 mr-1">
            <button
              type="button"
              onClick={() => setMode('split')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                mode === 'split' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Side-by-side view"
            >
              <Columns2 className="w-3 h-3" />
              Split
            </button>
            <button
              type="button"
              onClick={() => setMode('unified')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                mode === 'unified' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Unified view"
            >
              <AlignLeft className="w-3 h-3" />
              Unified
            </button>
          </div>
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

      {expanded && diff && mode === 'unified' && (
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <pre className="text-[12px] leading-5 font-mono p-0">
            {unifiedLines.map((line, i) => {
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

      {expanded && diff && mode === 'split' && (
        <div className="max-h-[480px] overflow-y-auto">
          {parsed.length === 0 && (
            <div className="px-4 py-3 text-xs text-slate-500 italic">No textual changes to display.</div>
          )}
          {parsed.map((file, fi) => (
            <div key={fi} className="border-b border-slate-800 last:border-b-0">
              <div className="px-4 py-1.5 bg-slate-900/70 text-[11px] font-mono text-slate-300 sticky top-0">
                {file.newPath || file.oldPath}
              </div>
              <table className="w-full font-mono text-[12px] leading-5 table-fixed">
                <colgroup>
                  <col style={{ width: '3rem' }} />
                  <col style={{ width: 'calc(50% - 3rem)' }} />
                  <col style={{ width: '3rem' }} />
                  <col style={{ width: 'calc(50% - 3rem)' }} />
                </colgroup>
                <tbody>
                  {file.rows.map((row, ri) => {
                    if (row.kind === 'hunk') {
                      return (
                        <tr key={ri} className="bg-blue-950/30 text-blue-400">
                          <td colSpan={4} className="px-4 font-semibold whitespace-pre">{row.header}</td>
                        </tr>
                      );
                    }
                    if (row.kind === 'context') {
                      return (
                        <tr key={ri} className="text-slate-300">
                          <td className="px-2 text-right text-slate-600 select-none border-r border-slate-800/60">{row.oldNo}</td>
                          <td className="px-2 whitespace-pre overflow-hidden text-ellipsis"><DiffCell text={row.text} /></td>
                          <td className="px-2 text-right text-slate-600 select-none border-r border-slate-800/60">{row.newNo}</td>
                          <td className="px-2 whitespace-pre overflow-hidden text-ellipsis"><DiffCell text={row.text} /></td>
                        </tr>
                      );
                    }
                    const oldHas = row.oldNo != null;
                    const newHas = row.newNo != null;
                    return (
                      <tr key={ri}>
                        <td className={`px-2 text-right select-none border-r border-slate-800/60 ${oldHas ? 'text-red-500/70 bg-red-950/20' : 'bg-slate-900/30'}`}>{oldHas ? row.oldNo : ''}</td>
                        <td className={`px-2 whitespace-pre overflow-hidden text-ellipsis ${oldHas ? 'text-red-200 bg-red-950/40' : 'bg-slate-900/30'}`}>
                          {oldHas ? <DiffCell text={row.oldText} /> : ' '}
                        </td>
                        <td className={`px-2 text-right select-none border-r border-slate-800/60 ${newHas ? 'text-emerald-500/70 bg-emerald-950/20' : 'bg-slate-900/30'}`}>{newHas ? row.newNo : ''}</td>
                        <td className={`px-2 whitespace-pre overflow-hidden text-ellipsis ${newHas ? 'text-emerald-200 bg-emerald-950/40' : 'bg-slate-900/30'}`}>
                          {newHas ? <DiffCell text={row.newText} /> : ' '}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffCell({ text }: { text: string }) {
  // Render an empty cell as a non-breaking space so the row keeps full height.
  return <span>{text.length === 0 ? ' ' : text}</span>;
}
