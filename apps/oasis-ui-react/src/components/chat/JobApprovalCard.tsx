import { useState } from 'react';
import { Box, Sparkles, AlertCircle, Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight, UserCheck } from 'lucide-react';
import { OASIS_BASE_URL } from '@/lib/constants';
import { MarkdownMessage } from './MarkdownMessage';

export interface JobApprovalPayload {
  job_id: string;
  status: 'preflight' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  task_count: number;
  parallel_allowed: number;
  degraded_mode: 'full' | 'sequential' | 'reduced';
  degraded_reason?: string;
  est_usd_low: number;
  est_usd_high: number;
  host_ram_mb: number;
  /** Set after approval — shows as completion report. */
  result?: string;
  error?: string;
  child_reports?: Array<{
    task_id: string;
    status: string;
    cost_usd?: number;
    final_message?: string;
  }>;
}

interface Props {
  payload: JobApprovalPayload;
}

/**
 * Renders a parallel-subagent job as a chat card. Shows preflight/cost info
 * before approval, transitions to running/completion after.
 *
 * Two modes:
 *   1. **Approval** (awaiting_approval) — user sees cost + capacity + editable budget
 *   2. **Status** (running / completed / failed) — reports from children
 */
export function JobApprovalCard({ payload }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [budgetOverride, setBudgetOverride] = useState<string>(
    String(payload.est_usd_high > 0 ? payload.est_usd_high * 1.2 : 5),
  );

  const needsApproval = payload.status === 'awaiting_approval' || payload.status === 'preflight';
  const isRunning = payload.status === 'running';
  const isDone = payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled';
  const isError = payload.status === 'failed' || payload.status === 'cancelled';

  const handleApprove = async () => {
    setBusy('approve');
    try {
      const limit = parseFloat(budgetOverride);
      const res = await fetch(`${OASIS_BASE_URL}/api/v1/coordinator/jobs/${payload.job_id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Number.isFinite(limit) ? { user_limit: limit } : {}),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err: any) {
      console.warn('Job approve failed:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    setBusy('reject');
    try {
      await fetch(`${OASIS_BASE_URL}/api/v1/coordinator/jobs/${payload.job_id}/cancel`, {
        method: 'POST',
      });
    } catch (err: any) {
      console.warn('Job reject failed:', err);
    } finally {
      setBusy(null);
    }
  };

  const accent =
    isError ? 'border-red-800/50 bg-red-950/20' :
    isRunning ? 'border-blue-700/60 bg-blue-950/25' :
    needsApproval ? 'border-amber-700/50 bg-amber-950/15' :
    'border-emerald-800/50 bg-emerald-950/15';

  const iconColor =
    isError ? 'text-red-400' :
    isRunning ? 'text-blue-400' :
    needsApproval ? 'text-amber-400' :
    'text-emerald-400';

  const statusLabel =
    isError ? 'Job failed' :
    isRunning ? 'Subagents running' :
    needsApproval ? 'Job cost estimate' :
    'Subagents complete';

  return (
    <div className={`rounded-xl border ${accent} overflow-hidden my-2`}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/60 border-b border-slate-800/60">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-slate-200 hover:text-white min-w-0"
        >
          {isError ? <AlertCircle className={`w-4 h-4 shrink-0 ${iconColor}`} /> :
            isRunning ? <Loader2 className={`w-4 h-4 shrink-0 animate-spin ${iconColor}`} /> :
            <Box className={`w-4 h-4 shrink-0 ${iconColor}`} />}
          <span className="truncate">{statusLabel}</span>
          <span className="text-[10px] text-slate-500 font-mono shrink-0">
            {payload.task_count} task{payload.task_count !== 1 ? 's' : ''}
          </span>
          {payload.degraded_mode !== 'full' && (
            <span className="text-[9px] text-amber-400 shrink-0">{payload.degraded_mode}</span>
          )}
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className="px-4 py-3 space-y-3">
          {/* ── Preflight info ──────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-y-1.5 text-[11px]">
            <span className="text-slate-500">Estimated cost</span>
            <span className="text-slate-200 font-mono text-right">
              ${payload.est_usd_low.toFixed(4)} – ${payload.est_usd_high.toFixed(4)}
            </span>
            <span className="text-slate-500">Parallel workers</span>
            <span className="text-slate-200 font-mono text-right">{payload.parallel_allowed}</span>
            <span className="text-slate-500">Host RAM free</span>
            <span className="text-slate-200 font-mono text-right">
              {payload.host_ram_mb > 1024
                ? `${(payload.host_ram_mb / 1024).toFixed(1)} GB`
                : `${payload.host_ram_mb} MB`}
            </span>
            {payload.degraded_reason && (
              <>
                <span className="text-slate-500">Degraded</span>
                <span className="text-amber-400 font-mono text-right text-[10px]">{payload.degraded_reason}</span>
              </>
            )}
          </div>

          {/* ── Approval card (only when awaiting approval) ─────────── */}
          {needsApproval && (
            <div className="rounded-lg border border-amber-800/30 bg-amber-950/20 p-3 space-y-2">
              <p className="text-[11px] text-amber-300 flex items-center gap-1.5">
                <UserCheck className="w-3.5 h-3.5" />
                This job needs your approval before dispatching subagents.
              </p>
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-slate-400 shrink-0">USD cap:</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={budgetOverride}
                  onChange={(e) => setBudgetOverride(e.target.value)}
                  className="flex-1 px-2 py-1 rounded bg-slate-900/80 border border-slate-700/50 text-xs text-slate-200"
                  aria-label="Job budget USD cap"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={handleApprove}
                  className="flex-1 py-1.5 rounded text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {busy === 'approve' ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                  Approve &amp; dispatch
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={handleReject}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50 flex items-center gap-1"
                >
                  <XCircle className="w-3 h-3" />
                  Reject
                </button>
              </div>
            </div>
          )}

          {/* ── Running / done state ────────────────────────────────── */}
          {isRunning && (
            <div className="flex items-center gap-2 text-[12px] text-blue-300 italic">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Subagents working — reports will appear below as they finish.
            </div>
          )}

          {isError && payload.error && (
            <div className="text-[12px] text-red-300 font-mono whitespace-pre-wrap">{payload.error}</div>
          )}

          {payload.result && (
            <div className="text-[13px] text-slate-200">
              <MarkdownMessage text={payload.result} />
            </div>
          )}

          {/* ── Child reports ───────────────────────────────────────── */}
          {payload.child_reports && payload.child_reports.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">Reports</span>
              {payload.child_reports.map((cr) => (
                <div key={cr.task_id} className="flex items-start gap-2 py-1 px-2 rounded bg-slate-900/40">
                  {cr.status === 'completed' ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 mt-0.5 shrink-0" />
                  ) : cr.status === 'failed' ? (
                    <XCircle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />
                  ) : (
                    <Loader2 className="w-3 h-3 animate-spin text-blue-400 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] text-slate-300 font-mono block truncate">{cr.task_id}</span>
                    {cr.cost_usd !== undefined && (
                      <span className="text-[9px] text-slate-500">${cr.cost_usd.toFixed(4)}</span>
                    )}
                    {cr.final_message && (
                      <span className="text-[11px] text-slate-400 block truncate">{cr.final_message}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!isRunning && (
            <div className="text-[10px] text-slate-600 font-mono">
              job {payload.job_id}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
