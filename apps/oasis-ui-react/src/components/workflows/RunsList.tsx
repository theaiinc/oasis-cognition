/**
 * Runs list for a workflow, plus per-run live-tail via SSE.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  CheckCircle2, XCircle, Loader2, Ban, Clock, ChevronDown, ChevronRight, RefreshCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';
import type { NodeStatus, RunStatus, WorkflowRun } from './types';

const API = `${OASIS_BASE_URL}/api/v1/workflows`;

const STATUS_COLOR: Record<RunStatus, string> = {
  queued:    'bg-slate-700/40 text-slate-300 border-slate-700',
  running:   'bg-purple-900/40 text-purple-300 border-purple-800/50',
  completed: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/50',
  failed:    'bg-red-900/40 text-red-400 border-red-800/50',
  cancelled: 'bg-slate-700/40 text-slate-400 border-slate-600/50',
};
const STATUS_ICON: Record<RunStatus, typeof CheckCircle2> = {
  queued:    Clock,
  running:   Loader2,
  completed: CheckCircle2,
  failed:    XCircle,
  cancelled: Ban,
};

interface RunsListProps {
  workflowId: string;
  onNodeStatusesChange?: (statuses: Record<string, { status: NodeStatus; error?: string }>) => void;
}

export function RunsList({ workflowId, onNodeStatusesChange }: RunsListProps) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<WorkflowRun | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/${workflowId}/runs?limit=25`);
      setRuns(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  // Poll while any run is non-terminal
  useEffect(() => {
    const any = runs.some(r => r.status === 'queued' || r.status === 'running');
    if (!any) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [runs, load]);

  const attachStream = useCallback((runId: string) => {
    esRef.current?.close();
    const es = new EventSource(`${API}/runs/${runId}/stream`);
    esRef.current = es;
    // Seed liveRun from the server snapshot
    axios.get(`${API}/runs/${runId}`).then(res => {
      setLiveRun(res.data);
      if (onNodeStatusesChange) {
        const statuses: Record<string, { status: NodeStatus; error?: string }> = {};
        for (const [nid, st] of Object.entries(res.data.node_states || {})) {
          statuses[nid] = { status: (st as { status: NodeStatus }).status, error: (st as { error?: string }).error };
        }
        onNodeStatusesChange(statuses);
      }
    }).catch(() => { /* silent */ });

    es.addEventListener('node', (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data);
        setLiveRun(prev => {
          if (!prev) return prev;
          const next: WorkflowRun = {
            ...prev,
            node_states: {
              ...prev.node_states,
              [p.node_id]: {
                ...(prev.node_states[p.node_id] || { status: 'pending' }),
                status: p.status,
                error: p.error,
                output: p.output,
              },
            },
          };
          if (onNodeStatusesChange) {
            const statuses: Record<string, { status: NodeStatus; error?: string }> = {};
            for (const [nid, st] of Object.entries(next.node_states)) {
              statuses[nid] = { status: st.status, error: st.error };
            }
            onNodeStatusesChange(statuses);
          }
          return next;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener('status', (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data);
        setLiveRun(prev => prev ? { ...prev, status: p.status, output: p.output ?? prev.output, error: p.error ?? prev.error } : prev);
        if (['completed', 'failed', 'cancelled'].includes(p.status)) {
          es.close();
          load();
        }
      } catch { /* ignore */ }
    });
    es.addEventListener('error', () => { es.close(); });
  }, [load, onNodeStatusesChange]);

  useEffect(() => () => { esRef.current?.close(); }, []);

  // Auto-attach to the most recent non-terminal run
  useEffect(() => {
    const active = runs.find(r => r.status === 'queued' || r.status === 'running');
    if (active && (!liveRun || liveRun.run_id !== active.run_id)) {
      setLiveRun(active);
      setExpandedId(active.run_id);
      attachStream(active.run_id);
    }
  }, [runs, liveRun, attachStream]);

  const cancel = useCallback(async (runId: string) => {
    try { await axios.post(`${API}/runs/${runId}/cancel`); await load(); }
    catch { /* silent */ }
  }, [load]);

  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-slate-300 font-semibold">Runs</h3>
        <Button variant="ghost" size="sm" className="h-6 text-[10px] text-slate-500 hover:text-slate-300" onClick={load}>
          <RefreshCcw className="w-3 h-3" />
        </Button>
      </div>

      {loading && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 text-purple-400 animate-spin" /></div>}
      {!loading && runs.length === 0 && <p className="text-slate-500 text-[11px]">No runs yet. Click Run to start.</p>}

      {runs.map(r => {
        const effectiveRun = liveRun && liveRun.run_id === r.run_id ? liveRun : r;
        const cfg = STATUS_COLOR[effectiveRun.status];
        const Icon = STATUS_ICON[effectiveRun.status];
        const expanded = expandedId === r.run_id;
        return (
          <div key={r.run_id} className="rounded border border-slate-800/50 bg-slate-950/40">
            <div
              className="flex items-start gap-2 p-2 cursor-pointer hover:bg-slate-800/40"
              onClick={() => {
                const next = expanded ? null : r.run_id;
                setExpandedId(next);
                if (next && effectiveRun.status === 'running') attachStream(r.run_id);
              }}
            >
              {expanded ? <ChevronDown className="w-3 h-3 text-slate-500 mt-0.5" /> : <ChevronRight className="w-3 h-3 text-slate-500 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px]', cfg)}>
                    <Icon className={cn('w-2.5 h-2.5', effectiveRun.status === 'running' && 'animate-spin')} />
                    {effectiveRun.status}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">{effectiveRun.trigger_type || 'manual'}</span>
                </div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">{r.run_id.slice(0, 8)} · {new Date(r.created_at).toLocaleTimeString()}</div>
              </div>
              {(effectiveRun.status === 'queued' || effectiveRun.status === 'running') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] text-red-400 hover:text-red-300"
                  onClick={(e) => { e.stopPropagation(); cancel(r.run_id); }}
                >
                  Cancel
                </Button>
              )}
            </div>
            {expanded && (
              <div className="px-3 pb-2 border-t border-slate-800/40 space-y-1">
                {effectiveRun.error && <div className="text-[10px] text-red-300 mt-1">Error: {effectiveRun.error}</div>}
                {effectiveRun.output !== undefined && (
                  <div className="mt-1">
                    <div className="text-[10px] text-slate-400">Output:</div>
                    <pre className="text-[10px] text-slate-300 bg-slate-950 border border-slate-800 rounded p-1.5 overflow-auto max-h-40">{JSON.stringify(effectiveRun.output, null, 2)}</pre>
                  </div>
                )}
                <div className="mt-1">
                  <div className="text-[10px] text-slate-400">Nodes:</div>
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    {Object.entries(effectiveRun.node_states).map(([nid, st]) => (
                      <div key={nid} className="text-[10px] flex items-center gap-1">
                        <span className={cn(
                          'inline-block w-1.5 h-1.5 rounded-full',
                          st.status === 'completed' && 'bg-emerald-400',
                          st.status === 'failed' && 'bg-red-400',
                          st.status === 'running' && 'bg-purple-400 animate-pulse',
                          st.status === 'skipped' && 'bg-slate-600',
                          st.status === 'pending' && 'bg-slate-700',
                        )} />
                        <span className="text-slate-400 truncate">{nid}</span>
                        <span className="text-slate-600">{st.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
