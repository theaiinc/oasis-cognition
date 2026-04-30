/**
 * Computer-use session history as an inline list.
 *
 * Rendered inside `ComputerUsePanel` when the user toggles into history mode.
 * This is the chrome-free counterpart to the old standalone `CuHistoryPanel`
 * that lived in `components/panels/` — merging it into the CU panel keeps
 * "past runs" close to the "current run" experience.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import {
  Trash2, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, PauseCircle, Ban, RefreshCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';
import type { CuSession, CuSessionStatus } from '@/lib/types';

const STATUS_CONFIG: Record<CuSessionStatus, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  completed:             { label: 'Completed',    color: 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50', icon: CheckCircle2 },
  failed:                { label: 'Failed',       color: 'bg-red-900/40 text-red-400 border-red-800/50',             icon: XCircle },
  cancelled:             { label: 'Cancelled',    color: 'bg-slate-700/40 text-slate-400 border-slate-600/50',       icon: Ban },
  paused:                { label: 'Paused',       color: 'bg-yellow-900/40 text-yellow-400 border-yellow-800/50',    icon: PauseCircle },
  executing:             { label: 'Executing',    color: 'bg-purple-900/40 text-purple-400 border-purple-800/50',    icon: Loader2 },
  planning:              { label: 'Planning',     color: 'bg-purple-900/40 text-purple-400 border-purple-800/50',    icon: Loader2 },
  awaiting_approval:     { label: 'Awaiting',     color: 'bg-amber-900/40 text-amber-400 border-amber-800/50',       icon: Loader2 },
  awaiting_click_assist: { label: 'Click Assist', color: 'bg-amber-900/40 text-amber-400 border-amber-800/50',       icon: Loader2 },
};

function StepStatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
  if (status === 'failed') return <XCircle className="w-3 h-3 text-red-400" />;
  if (status === 'running') return <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />;
  if (status === 'skipped') return <Ban className="w-3 h-3 text-slate-500" />;
  return <div className="w-3 h-3 rounded-full border border-slate-600" />;
}

export interface CuHistoryListProps {
  /** Optional: fired when the user clicks a session card (e.g. to load it as the current session). */
  onSelectSession?: (sessionId: string) => void;
  /** When true, the list auto-refreshes every 3s. Useful while sessions are in-flight. */
  autoRefreshMs?: number;
}

export function CuHistoryList({ onSelectSession, autoRefreshMs = 3000 }: CuHistoryListProps) {
  const [sessions, setSessions] = useState<CuSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/computer-use/sessions`, { timeout: 5000 });
      setSessions(Array.isArray(res.data) ? res.data : []);
    } catch {
      /* keep prior list on transient errors */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    if (!autoRefreshMs) return;
    const t = setInterval(fetchSessions, autoRefreshMs);
    return () => clearInterval(t);
  }, [fetchSessions, autoRefreshMs]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await axios.delete(`${OASIS_BASE_URL}/api/v1/computer-use/sessions/${sessionId}`, { timeout: 5000 });
      setSessions(prev => prev.filter(s => s.session_id !== sessionId));
      if (expandedId === sessionId) setExpandedId(null);
    } catch { /* ignore */ }
  }, [expandedId]);

  const completedSteps = (s: CuSession) => s.plan.filter(st => st.status === 'completed').length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-300">Past sessions</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] text-slate-500 hover:text-slate-300"
          onClick={fetchSessions}
          title="Refresh"
        >
          <RefreshCcw className="w-3 h-3" />
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <p className="text-xs text-slate-500 text-center py-8">
          No computer use sessions yet.
        </p>
      )}

      <div className="flex flex-col gap-1">
        {sessions.map(s => {
          const cfg = STATUS_CONFIG[s.status] || STATUS_CONFIG.completed;
          const StatusIcon = cfg.icon;
          const expanded = expandedId === s.session_id;

          return (
            <div key={s.session_id} className="rounded-lg border border-slate-800/50 overflow-hidden">
              <div
                className="group flex items-start gap-2 p-2.5 cursor-pointer hover:bg-slate-800/50 transition-colors"
                onClick={() => setExpandedId(expanded ? null : s.session_id)}
              >
                <div className="mt-0.5 flex-shrink-0">
                  {expanded
                    ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                    : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-300 truncate">{s.goal || 'Untitled session'}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px]', cfg.color)}>
                      <StatusIcon className={cn('w-2.5 h-2.5', s.status === 'executing' && 'animate-spin')} />
                      {cfg.label}
                    </span>
                    <span className="text-[10px] text-slate-600">
                      {completedSteps(s)}/{s.plan.length} steps
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-600 mt-0.5">
                    {new Date(s.created_at).toLocaleDateString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
                {onSelectSession && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] text-purple-400 hover:text-purple-300 opacity-0 group-hover:opacity-100"
                    onClick={e => { e.stopPropagation(); onSelectSession(s.session_id); }}
                  >
                    Open
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-6 h-6 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 flex-shrink-0"
                  onClick={e => { e.stopPropagation(); deleteSession(s.session_id); }}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>

              <AnimatePresence>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <div className="px-3 pb-2.5 border-t border-slate-800/50">
                      {s.summary && (
                        <p className="text-[11px] text-slate-400 mt-2 mb-1.5 italic whitespace-pre-wrap">{s.summary}</p>
                      )}
                      {s.error && (
                        <p className="text-[11px] text-red-400 mt-2 mb-1.5">Error: {s.error}</p>
                      )}
                      {s.plan.length === 0 ? (
                        <p className="text-[10px] text-slate-600 mt-2">No plan steps.</p>
                      ) : (
                        <div className="mt-2 flex flex-col gap-1">
                          {s.plan.map(step => (
                            <div key={step.index} className="flex items-start gap-1.5">
                              <div className="mt-0.5 flex-shrink-0">
                                <StepStatusIcon status={step.status} />
                              </div>
                              <p className="text-[11px] text-slate-400 leading-tight">
                                {step.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
