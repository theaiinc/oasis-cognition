import { useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Pause, Play, Trash2, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import { OASIS_BASE_URL } from '@/lib/constants';
import { MarkdownMessage } from './MarkdownMessage';

export interface MissionDigestPayload {
  mission_id: string;
  goal: string;
  result?: string;
  error?: string;
  run_count: number;
  finished_at: string;
  started_at?: string;
  triggered_by?: 'schedule' | 'manual';
  /** True while the run is in flight (set by MissionRunStarted, cleared on MissionRunCompleted). */
  running?: boolean;
}

interface Props {
  payload: MissionDigestPayload;
}

/**
 * Renders a single mission run's result as a chat card. Same visual lane as
 * DiffViewer / ToolCallsScrollContainer — shows up inline in the conversation
 * so the user sees what their background agents have been doing.
 *
 * Supports inline pause / resume / re-run / delete so the user doesn't have to
 * navigate to a separate Missions panel for routine maintenance.
 */
export function MissionDigestCard({ payload }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  const isError = !!payload.error;
  const isRunning = !!payload.running;
  const action = async (path: string, method: 'POST' | 'DELETE' = 'POST') => {
    setBusy(path);
    try {
      const url = `${OASIS_BASE_URL}/api/v1/missions/${payload.mission_id}${path}`;
      const r = await fetch(url, { method });
      if (!r.ok) throw new Error(await r.text());
      if (method === 'DELETE') setHidden(true);
    } catch (err) {
      console.warn('Mission action failed:', err);
    } finally {
      setBusy(null);
    }
  };

  const accent =
    isError ? 'border-red-800/50 bg-red-950/20' :
    isRunning ? 'border-violet-700/60 bg-violet-950/25' :
    'border-violet-800/50 bg-violet-950/15';

  return (
    <div className={`rounded-xl border ${accent} overflow-hidden my-2`}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/60 border-b border-slate-800/60">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-violet-300 hover:text-violet-200 min-w-0"
        >
          {isError ? <AlertCircle className="w-4 h-4 text-red-400 shrink-0" /> :
            isRunning ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> :
            <Sparkles className="w-4 h-4 shrink-0" />}
          <span className="truncate" title={payload.goal}>
            {isError ? 'Mission failed' : isRunning ? 'Mission running' : 'Mission digest'}: {payload.goal}
          </span>
          {!isRunning && <span className="text-[10px] text-slate-500 font-mono shrink-0">#{payload.run_count}</span>}
          {payload.triggered_by === 'manual' && <span className="text-[9px] text-slate-500 shrink-0">manual</span>}
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => action('/run')}
            title="Run again now"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy === '/run' ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => action('/pause')}
            title="Pause mission"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => action('/resume')}
            title="Resume mission"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => action('', 'DELETE')}
            title="Delete mission"
            className="p-1 rounded text-slate-400 hover:text-red-300 hover:bg-red-950/40 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 py-3">
          {isRunning ? (
            <div className="text-[12px] text-violet-300 italic flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Working on it{payload.started_at ? ` since ${new Date(payload.started_at).toLocaleTimeString()}` : ''}…
            </div>
          ) : isError ? (
            <div className="text-[12px] text-red-300 font-mono whitespace-pre-wrap">{payload.error}</div>
          ) : payload.result ? (
            <div className="text-[13px] text-slate-200">
              <MarkdownMessage text={payload.result} />
            </div>
          ) : (
            <div className="text-[12px] text-slate-500 italic">No output captured for this run.</div>
          )}
          {!isRunning && (
            <div className="mt-2 text-[10px] text-slate-600 font-mono">
              mission {payload.mission_id} · finished {new Date(payload.finished_at).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
