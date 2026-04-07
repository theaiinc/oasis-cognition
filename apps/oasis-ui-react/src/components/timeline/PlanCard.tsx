import { motion } from 'framer-motion';
import { ListChecks, Check, Square, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TimelineEvent } from '@/lib/types';

function matchesPlanRevision(
  payload: Record<string, unknown> | undefined,
  planRev: number,
): boolean {
  const pr = payload?.plan_revision;
  if (typeof pr !== 'number') {
    return planRev === 0;
  }
  return pr === planRev;
}

/** Observer / logic-engine per-step status (from CompletionNode on task graph). */
type StepStatusRow = {
  step_index?: number;
  status?: string;
  description?: string;
};

function extractLatestStepStatuses(events: TimelineEvent[]): StepStatusRow[] | null {
  const tgEvents = events.filter(e => e.event_type === 'TaskGraphUpdated');
  const last = tgEvents[tgEvents.length - 1];
  const graph = (last?.payload as Record<string, unknown> | undefined)?.task_graph as
    | { nodes?: Array<{ node_type?: string; attributes?: Record<string, unknown> }> }
    | undefined;
  if (!graph?.nodes?.length) return null;
  const completions = graph.nodes.filter(
    n => n.node_type === 'CompletionNode' || n.node_type === 'Completion',
  );
  const node = completions[completions.length - 1];
  const raw = node?.attributes?.step_statuses;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw as StepStatusRow[];
}

interface PlanCardProps {
  events: TimelineEvent[];
}

export function PlanCard({ events }: PlanCardProps) {
  // Use the latest ToolPlanReady event so the UI reflects the most recent planning output.
  const planEvent = [...events].reverse().find(e => e.event_type === 'ToolPlanReady');
  if (!planEvent?.payload) return null;

  const payload = planEvent.payload as Record<string, unknown>;
  const steps = (payload.steps as Array<{ step_index?: number; description?: string } | string>) || [];
  const criteria = (payload.success_criteria as string[]) || [];
  if (steps.length === 0 && criteria.length === 0) return null;

  const planRev = typeof payload.plan_revision === 'number' ? payload.plan_revision : 0;
  const planRevised = payload.plan_revised === true;

  const starts = events.filter(
    e => e.event_type === 'ToolCallStarted' && matchesPlanRevision(e.payload as Record<string, unknown>, planRev),
  );
  const completions = events.filter(
    e => e.event_type === 'ToolCallCompleted' && matchesPlanRevision(e.payload as Record<string, unknown>, planRev),
  );
  const successfulCompletions = completions.filter(
    e => (e.payload as Record<string, unknown>).success === true,
  );
  const successfulCount = successfulCompletions.length;
  const hasRunningTool = starts.length > completions.length;

  const stepStatuses = extractLatestStepStatuses(events);
  const anyCompletionHasStepIndex = completions.some(
    e => typeof (e.payload as Record<string, unknown>).step_index === 'number',
  );

  const isStepDone = (stepIndex: number): boolean => {
    if (stepStatuses?.length) {
      const row =
        stepStatuses.find(s => Number(s.step_index) === stepIndex) ?? stepStatuses[stepIndex];
      return row?.status === 'done';
    }
    if (anyCompletionHasStepIndex) {
      return successfulCompletions.some(e => {
        const p = e.payload as Record<string, unknown>;
        return p.step_index === stepIndex;
      });
    }
    // Legacy: N successful tools implied first N steps done — wrong for unrelated tools (e.g. install vs read).
    return successfulCount > stepIndex;
  };

  const firstPendingIndex = (): number => {
    if (stepStatuses?.length) {
      for (let i = 0; i < steps.length; i++) {
        if (!isStepDone(i)) return i;
      }
      return Math.max(0, steps.length - 1);
    }
    return Math.min(successfulCount, Math.max(0, steps.length - 1));
  };

  const lastStart = starts[starts.length - 1];
  const lastStartPayload = lastStart?.payload as Record<string, unknown> | undefined;
  const lastStartStepIndex = typeof lastStartPayload?.step_index === 'number' ? lastStartPayload.step_index : null;

  const lastCompletion = completions[completions.length - 1];
  const lastCompletionPayload = lastCompletion?.payload as Record<string, unknown> | undefined;
  const lastCompletionStepIndex = typeof lastCompletionPayload?.step_index === 'number' ? lastCompletionPayload.step_index : null;

  const pendingIdx = firstPendingIndex();
  const allStepsDone = steps.length > 0 && steps.every((_, i) => isStepDone(i));

  const currentStepIndex =
    stepStatuses?.length
      ? hasRunningTool && lastStartStepIndex != null
        ? lastStartStepIndex
        : pendingIdx
      : hasRunningTool && lastStartStepIndex != null
        ? lastStartStepIndex
        : lastCompletionStepIndex != null
          ? Math.min(lastCompletionStepIndex + 1, Math.max(0, steps.length - 1))
          : pendingIdx;

  const revisionReason =
    typeof payload.revision_reason === 'string' ? payload.revision_reason.trim().slice(0, 220) : '';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-slate-800/60 bg-slate-900/30 overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-slate-800/40 flex items-center gap-2">
        <ListChecks className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
        <span className="text-[11px] font-medium text-slate-300">Execution plan</span>
        {planRevised && (
          <span className="ml-auto flex items-center gap-1 rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-200/90">
            <RefreshCw className="w-3 h-3" />
            Revised
          </span>
        )}
      </div>
      {planRevised && (
        <div className="px-3 py-1.5 text-[10px] leading-snug text-slate-500 border-b border-slate-800/30 bg-slate-950/40">
          Observer requested a new plan; step checkmarks below count only tools run under this plan.
          {revisionReason
            ? ` ${revisionReason.length >= 220 ? `${revisionReason}…` : revisionReason}`
            : ''}
        </div>
      )}
      <div className="px-3 py-2 space-y-2">
        {steps.length > 0 && (
          <div className="text-[11px]">
            <span className="text-slate-500 font-semibold">Steps:</span>
            <ol className="mt-1 space-y-1 list-none max-h-24 overflow-y-auto">
              {steps.map((s, i) => {
                const isDone = isStepDone(i);
                const isCurrent = !allStepsDone && i === currentStepIndex && (hasRunningTool || !isDone);
                const desc = typeof s === 'string' ? s : (s as { description?: string }).description || `Step ${i + 1}`;
                return (
                  <li
                    key={i}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-2 py-0.5 -mx-2 transition-colors',
                      isCurrent && 'bg-blue-500/15 border border-blue-500/30',
                      isDone && !isCurrent && 'opacity-90',
                    )}
                  >
                    <span className="flex-shrink-0 mt-0.5 text-slate-400">
                      {isDone ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-slate-600" />
                      )}
                    </span>
                    <span className="text-slate-300">
                      {desc}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {criteria.length > 0 && (
          <div className="text-[11px] max-h-16 overflow-y-auto">
            <span className="text-slate-500 font-semibold">Success criteria:</span>
            <ul className="mt-1 space-y-0.5 list-disc list-inside text-slate-400">
              {criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </motion.div>
  );
}
