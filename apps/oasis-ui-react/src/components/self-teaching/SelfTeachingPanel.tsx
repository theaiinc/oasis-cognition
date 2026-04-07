import { useMemo, useState } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { X, BookOpen, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import type {
  ApproveSelfTeachingResponse,
  LlmThought,
  LogicSolution,
  RuleAction,
  TeachingPlan,
} from '@/lib/self-teaching-api';
import { adjustSelfTeaching, approveSelfTeaching, rejectSelfTeaching, startSelfTeaching } from '@/lib/self-teaching-api';

type Stage = 'idle' | 'generating' | 'awaiting_approval' | 'teaching' | 'completed' | 'rejected' | 'error';

/** Which rule bundle to apply on approve (default = top-level rule_actions from API). */
type ApplySelection =
  | { kind: 'default' }
  | { kind: 'path'; pathId: string }
  | { kind: 'all' };

function ConfidencePill({ confidence, tone }: { confidence: number; tone: 'good' | 'warn' | 'neutral' }) {
  return (
    <span
      className={cn(
        'text-[10px] font-medium px-2 py-1 rounded-full border backdrop-blur',
        tone === 'good' && 'text-emerald-300 border-emerald-900/50 bg-emerald-950/20',
        tone === 'warn' && 'text-amber-200 border-amber-900/50 bg-amber-950/20',
        tone === 'neutral' && 'text-slate-300 border-slate-800 bg-slate-900/40'
      )}
    >
      {(confidence * 100).toFixed(0)}%
    </span>
  );
}

function RuleActionSummary({ action }: { action: RuleAction }) {
  if (action.action === 'teach_rule') {
    const conclusion =
      'conclusion' in action
        ? action.conclusion
        : action.assertion;
    const condition = 'conclusion' in action ? action.condition : action.underlying_concept;
    return (
      <span className="text-slate-300">
        Teach: {condition ? <span className="text-slate-400">IF {condition} </span> : null}
        THEN {conclusion}
      </span>
    );
  }
  if (action.action === 'update_rule') return <span className="text-slate-300">Update rule `{action.rule_id}`</span>;
  return <span className="text-slate-300">Delete rule `{action.rule_id}`</span>;
}

export function SelfTeachingPanel({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [stage, setStage] = useState<Stage>('idle');
  const [topic, setTopic] = useState('');
  const [selfTeachingId, setSelfTeachingId] = useState<string | null>(null);

  const [llmThoughts, setLlmThoughts] = useState<LlmThought[]>([]);
  const [logicSolution, setLogicSolution] = useState<LogicSolution | null>(null);
  const [teachingPlan, setTeachingPlan] = useState<TeachingPlan | null>(null);

  const [teachingResults, setTeachingResults] = useState<ApproveSelfTeachingResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const [adjustmentComment, setAdjustmentComment] = useState<string>('');
  const [adjustingPlan, setAdjustingPlan] = useState(false);
  const [lastAdjustedComment, setLastAdjustedComment] = useState<string>('');
  const [applySelection, setApplySelection] = useState<ApplySelection>({ kind: 'default' });

  const canStart = useMemo(() => topic.trim().length > 0 && (stage === 'idle' || stage === 'rejected' || stage === 'completed' || stage === 'error'), [topic, stage]);

  const subtopicById = useMemo(() => {
    const m = new Map<string, string>();
    (teachingPlan?.subtopics ?? []).forEach((s) => m.set(s.id, (s.title ?? '').trim() || s.id));
    return m;
  }, [teachingPlan?.subtopics]);

  const effectiveRuleActions = useMemo(() => {
    if (!teachingPlan) return [];
    if (applySelection.kind === 'all') {
      const paths = teachingPlan.teaching_paths ?? [];
      if (paths.length === 0) return teachingPlan.rule_actions ?? [];
      return paths.flatMap((p) => p.rule_actions ?? []);
    }
    if (applySelection.kind === 'path') {
      const p = teachingPlan.teaching_paths?.find((x) => x.path_id === applySelection.pathId);
      return p?.rule_actions ?? [];
    }
    return teachingPlan.rule_actions ?? [];
  }, [teachingPlan, applySelection]);

  const resetAll = () => {
    setStage('idle');
    setSelfTeachingId(null);
    setLlmThoughts([]);
    setLogicSolution(null);
    setTeachingPlan(null);
    setTeachingResults(null);
    setErrorMessage('');
    setAdjustmentComment('');
    setAdjustingPlan(false);
    setLastAdjustedComment('');
    setApplySelection({ kind: 'default' });
  };

  const handleStart = async () => {
    const trimmed = topic.trim();
    if (!trimmed) return;
    setStage('generating');
    setErrorMessage('');
    setAdjustmentComment('');
    setAdjustingPlan(false);
    setApplySelection({ kind: 'default' });
    try {
      const res = await startSelfTeaching(trimmed);
      setSelfTeachingId(res.self_teaching_id);
      setLlmThoughts(res.llm_thoughts || []);
      setLogicSolution(res.logic_solution);
      setTeachingPlan(res.teaching_plan);
      setStage('awaiting_approval');
    } catch (e: unknown) {
      const detail = axios.isAxiosError(e)
        ? (e.response?.data as { detail?: string } | undefined)?.detail || e.message
        : e instanceof Error
          ? e.message
          : 'Failed to start self teaching';
      setErrorMessage(detail);
      setStage('error');
      toast({ title: 'Self teaching start failed', description: detail, variant: 'destructive' });
    }
  };

  const handleReject = async () => {
    if (!selfTeachingId) return;
    setStage('rejected');
    try {
      await rejectSelfTeaching(selfTeachingId);
    } catch {
      // Still consider it rejected in UI; backend is best-effort.
    } finally {
      toast({ title: 'Teaching rejected', description: 'No rules were applied.', variant: 'default' });
    }
  };

  const handleApprove = async () => {
    if (!selfTeachingId) return;
    setErrorMessage('');

    // If the user provided a new adjustment comment, regenerate the plan first.
    // This ensures the "Approve & Teach" action applies the corrected rule_actions.
    const trimmed = adjustmentComment.trim();
    if (trimmed && trimmed !== lastAdjustedComment) {
      setAdjustingPlan(true);
      try {
        const res = await adjustSelfTeaching(selfTeachingId, trimmed);
        setTeachingPlan(res.teaching_plan);
        setLastAdjustedComment(trimmed);
        setApplySelection({ kind: 'default' });
      } catch (e: unknown) {
        const detail = axios.isAxiosError(e)
          ? (e.response?.data as { detail?: string } | undefined)?.detail || e.message
          : e instanceof Error
            ? e.message
            : 'Failed to update plan before teaching';
        setErrorMessage(detail);
        toast({ title: 'Update failed', description: detail, variant: 'destructive' });
        setStage('error');
        return;
      } finally {
        setAdjustingPlan(false);
      }
    }

    setStage('teaching');
    try {
      const approveOpts =
        applySelection.kind === 'all'
          ? { apply_all_teaching_paths: true as const }
          : applySelection.kind === 'path'
            ? { selected_teaching_path_id: applySelection.pathId }
            : undefined;
      const res = await approveSelfTeaching(selfTeachingId, approveOpts);
      setTeachingResults(res);
      setStage('completed');
      toast({
        title: 'Teaching applied',
        description: `Applied ${effectiveRuleActions.length} rule action(s).`,
        variant: 'default',
      });
    } catch (e: unknown) {
      const detail = axios.isAxiosError(e)
        ? (e.response?.data as { detail?: string } | undefined)?.detail || e.message
        : e instanceof Error
          ? e.message
          : 'Teaching failed';
      setErrorMessage(detail);
      setStage('error');
      toast({ title: 'Teaching failed', description: detail, variant: 'destructive' });
    }
  };

  const handleUpdatePlan = async () => {
    if (!selfTeachingId) return;
    const trimmed = adjustmentComment.trim();
    if (!trimmed) return;
    setAdjustingPlan(true);
    setErrorMessage('');
    try {
      const res = await adjustSelfTeaching(selfTeachingId, trimmed);
      setTeachingPlan(res.teaching_plan);
      toast({ title: 'Plan updated', description: 'LLM adjusted rules using your comment.', variant: 'default' });
      setLastAdjustedComment(trimmed);
      setApplySelection({ kind: 'default' });
    } catch (e: unknown) {
      const detail = axios.isAxiosError(e)
        ? (e.response?.data as { detail?: string } | undefined)?.detail || e.message
        : e instanceof Error
          ? e.message
          : 'Failed to update plan';
      setErrorMessage(detail);
      toast({ title: 'Update failed', description: detail, variant: 'destructive' });
    } finally {
      setAdjustingPlan(false);
    }
  };

  const titleRight = (
    <div className="flex items-center gap-2">
      {stage === 'generating' ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : null}
      {adjustingPlan ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : null}
      {stage === 'completed' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : null}
      {stage === 'rejected' ? <AlertTriangle className="w-4 h-4 text-amber-300" /> : null}
    </div>
  );

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 440, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="border-r border-slate-800 bg-[#0a0f1a] overflow-hidden flex flex-col"
    >
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-5 h-5 text-blue-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-300 truncate">Self Teaching</div>
            <div className="text-[11px] text-slate-500 truncate">
              Multi-part topics → subtopics & paths → batch rules
            </div>
          </div>
        </div>
        {titleRight}
        <Button variant="ghost" size="sm" className="text-slate-500 hover:text-white" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 p-3">
            <label className="text-xs text-slate-400 font-medium mb-1.5 block">
              Problem / task to self-teach (one focus or many subtopics)
            </label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={
                'Describe the full task or problem — including sub-goals, constraints, and context.\n' +
                'Example: "Ship a secure file upload: validation, storage, virus scan, audit log, and rollback…"'
              }
              className="w-full min-h-[160px] px-3 py-2 bg-slate-900/60 border border-slate-700/50 rounded-lg text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
              disabled={stage === 'generating' || stage === 'teaching'}
            />
            <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
              <Button
                onClick={handleStart}
                disabled={!canStart}
                className="bg-blue-600 hover:bg-blue-500 text-white"
              >
                Start
              </Button>
              {(stage === 'awaiting_approval' || stage === 'completed' || stage === 'rejected' || stage === 'error') && (
                <Button
                  variant="ghost"
                  onClick={resetAll}
                  className="text-slate-400 hover:text-white"
                >
                  Reset
                </Button>
              )}
            </div>
            {selfTeachingId && (
              <div className="mt-2 text-[11px] text-slate-500 font-mono">
                self_teaching_id: {selfTeachingId}
              </div>
            )}
          </div>

          <AnimatePresence>
            {stage === 'generating' && (
              <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 p-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                  <div>
                    <div className="text-sm font-semibold text-slate-200">Thinking + solving…</div>
                    <div className="text-[11px] text-slate-500">Generating LLM thoughts, running logic engine, proposing teaching plan.</div>
                  </div>
                </div>
              </div>
            )}
          </AnimatePresence>

          {errorMessage ? (
            <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-3">
              <div className="text-xs font-semibold text-red-200">Error</div>
              <div className="text-[11px] text-red-200/80 mt-1 whitespace-pre-wrap">{errorMessage}</div>
            </div>
          ) : null}

          {stage !== 'idle' && stage !== 'generating' && llmThoughts.length > 0 && (
            <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                    <span className="text-amber-200 text-xs font-bold">LLM</span>
                  </div>
                  <div className="text-sm font-semibold text-slate-200">Agent thoughts</div>
                </div>
                <div className="text-[11px] text-slate-500">{llmThoughts.length} candidate thoughts</div>
              </div>

              <div className="space-y-2">
                {llmThoughts.map((t, idx) => {
                  const c = t.confidence ?? 0;
                  const tone = c >= 0.7 ? 'good' : c >= 0.4 ? 'warn' : 'neutral';
                  return (
                    <div key={idx} className="rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5">
                      <div className="flex items-start gap-2">
                        <ConfidencePill confidence={c} tone={tone} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-semibold text-slate-200">Thought {idx + 1}</div>
                          {t.rationale ? (
                            <div className="text-[11px] text-slate-400 mt-1 whitespace-pre-wrap">Rationale: {t.rationale}</div>
                          ) : null}
                          <div className="text-[12px] text-slate-200 mt-1 whitespace-pre-wrap">{t.thought}</div>
                          {t.validated === false && t.rejection_reason ? (
                            <div className="text-[11px] text-amber-200/80 mt-2">
                              Not validated: {t.rejection_reason}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {logicSolution ? (
            <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                    <span className="text-blue-200 text-xs font-bold">LOGIC</span>
                  </div>
                  <div className="text-sm font-semibold text-slate-200">Logic engine solution</div>
                </div>
                <ConfidencePill confidence={logicSolution.confidence ?? 0} tone={logicSolution.confidence >= 0.7 ? 'good' : logicSolution.confidence >= 0.4 ? 'warn' : 'neutral'} />
              </div>

              <div className="rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5">
                <div className="text-[12px] font-semibold text-slate-200">Conclusion</div>
                <div className="text-[12px] text-slate-100 mt-1 whitespace-pre-wrap">{logicSolution.conclusion}</div>
                {logicSolution.reasoning_trace && logicSolution.reasoning_trace.length > 0 ? (
                  <div className="mt-3">
                    <div className="text-[11px] font-semibold text-slate-400">Reasoning trace</div>
                    <ol className="mt-1 list-decimal list-inside text-[11px] text-slate-300 space-y-1">
                      {logicSolution.reasoning_trace.map((s, i) => (
                        <li key={i} className="whitespace-pre-wrap">{s}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {teachingPlan ? (
            <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                    <span className="text-purple-200 text-xs font-bold">PLAN</span>
                  </div>
                  <div className="text-sm font-semibold text-slate-200">Proposed teaching plan</div>
                </div>
                {stage === 'awaiting_approval' ? (
                  <div className="text-[11px] text-amber-200">Approve to apply rules</div>
                ) : null}
              </div>

              <div className="space-y-3">
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 mb-1">Teaching material</div>
                  <div className="text-[12px] text-slate-200 whitespace-pre-wrap leading-relaxed rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5">
                    {teachingPlan.teaching_material}
                  </div>
                </div>

                {teachingPlan.achievement_flow?.trim() ? (
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400 mb-1">How to achieve this task</div>
                    <div className="text-[12px] text-slate-200 whitespace-pre-wrap leading-relaxed rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5">
                      {teachingPlan.achievement_flow}
                    </div>
                  </div>
                ) : null}

                {(teachingPlan.subtopics?.length ?? 0) > 0 ? (
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400 mb-1">Subtopics</div>
                    <ul className="space-y-1.5">
                      {teachingPlan.subtopics!.map((s) => (
                        <li
                          key={s.id}
                          className="text-[11px] text-slate-300 rounded-md border border-slate-800/60 bg-slate-900/30 px-2.5 py-2"
                        >
                          <span className="font-semibold text-slate-200">{s.title || s.id}</span>
                          {s.summary?.trim() ? (
                            <span className="text-slate-500"> — {s.summary}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {(teachingPlan.teaching_paths?.length ?? 0) > 0 && stage === 'awaiting_approval' ? (
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400 mb-1.5">Teaching strategy (logic brain)</div>
                    <div className="space-y-2 rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5">
                      <label className="flex items-start gap-2 cursor-pointer text-[11px] text-slate-300">
                        <input
                          type="radio"
                          name="self-teaching-path"
                          className="mt-0.5"
                          checked={applySelection.kind === 'default'}
                          onChange={() => setApplySelection({ kind: 'default' })}
                        />
                        <span>
                          <span className="font-semibold text-slate-200">Recommended (default)</span>
                          <span className="text-slate-500"> — {(teachingPlan.rule_actions?.length ?? 0)} rules</span>
                        </span>
                      </label>
                      {teachingPlan.teaching_paths!.map((p) => (
                        <label key={p.path_id} className="flex items-start gap-2 cursor-pointer text-[11px] text-slate-300">
                          <input
                            type="radio"
                            name="self-teaching-path"
                            className="mt-0.5"
                            checked={applySelection.kind === 'path' && applySelection.pathId === p.path_id}
                            onChange={() => setApplySelection({ kind: 'path', pathId: p.path_id })}
                          />
                          <span>
                            <span className="font-semibold text-slate-200">{p.title || p.path_id}</span>
                            <span className="text-slate-500"> — {(p.rule_actions?.length ?? 0)} rules</span>
                            {p.description?.trim() ? (
                              <span className="block text-slate-500 mt-0.5 whitespace-pre-wrap">{p.description}</span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                      <label className="flex items-start gap-2 cursor-pointer text-[11px] text-slate-300">
                        <input
                          type="radio"
                          name="self-teaching-path"
                          className="mt-0.5"
                          checked={applySelection.kind === 'all'}
                          onChange={() => setApplySelection({ kind: 'all' })}
                        />
                        <span>
                          <span className="font-semibold text-slate-200">All paths (merge)</span>
                          <span className="text-slate-500"> — concat every path’s rules (memory may dedupe)</span>
                        </span>
                      </label>
                    </div>
                  </div>
                ) : null}

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="text-[11px] font-semibold text-slate-400">Rules to apply (preview)</div>
                    <div className="text-[10px] text-slate-500 font-mono">{effectiveRuleActions.length} actions</div>
                  </div>
                  <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                    {effectiveRuleActions.map((a, idx) => {
                      const sid = a.action === 'teach_rule' && 'subtopic_id' in a && a.subtopic_id ? a.subtopic_id : null;
                      const stitle = sid ? subtopicById.get(sid) : undefined;
                      return (
                        <div
                          key={idx}
                          className="rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5 flex items-start justify-between gap-3"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-semibold text-slate-200">Action {idx + 1}</div>
                            {stitle ? (
                              <div className="text-[10px] text-violet-300/90 mt-0.5">Subtopic: {stitle}</div>
                            ) : null}
                            <RuleActionSummary action={a} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-200">Approval</div>
                <div className="text-[11px] text-slate-500">User gates whether the teaching plan is applied.</div>
              </div>
              {stage === 'awaiting_approval' ? (
                <div className="space-y-3">
                  <div className="rounded-md border border-slate-800/60 bg-slate-900/30 p-2.5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Adjust proposed plan</div>
                        <div className="text-[11px] text-slate-500">Optional: tell the LLM how to tweak rules / paths / subtopics.</div>
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">{adjustmentComment.trim().length}/500</div>
                    </div>
                    <textarea
                      value={adjustmentComment}
                      onChange={(e) => setAdjustmentComment(e.target.value.slice(0, 500))}
                      placeholder="e.g., Condition should be more specific to 'user-upload' events; remove 'general' wording."
                      className="w-full min-h-[70px] px-3 py-2 bg-slate-900/60 border border-slate-700/50 rounded-lg text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
                      disabled={adjustingPlan}
                    />
                    <div className="flex items-center justify-between gap-2 mt-2">
                      <Button
                        variant="secondary"
                        onClick={handleUpdatePlan}
                        disabled={adjustingPlan || adjustmentComment.trim().length === 0}
                        className="text-slate-200 border border-slate-700/50 hover:bg-slate-800/50"
                      >
                        {adjustingPlan ? (
                          <span className="flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Updating…
                          </span>
                        ) : (
                          'Update plan'
                        )}
                      </Button>
                      <div className="text-[11px] text-slate-500">Updates `rule_actions` + material.</div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={handleReject}
                      disabled={adjustingPlan}
                      className="text-slate-200 border border-slate-700/50 hover:bg-slate-800/50"
                    >
                      Reject
                    </Button>
                    <Button onClick={handleApprove} disabled={adjustingPlan} className="bg-blue-600 hover:bg-blue-500 text-white">
                      Approve & Teach
                    </Button>
                  </div>
                </div>
              ) : stage === 'completed' ? (
                <div className="text-[11px] text-emerald-300 font-medium">Teaching finished</div>
              ) : stage === 'rejected' ? (
                <div className="text-[11px] text-amber-200 font-medium">Teaching rejected</div>
              ) : stage === 'teaching' ? (
                <div className="text-[11px] text-slate-300 font-medium flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Teaching in progress…
                </div>
              ) : null}
            </div>

            {teachingResults && stage !== 'awaiting_approval' && (
              <div className="mt-3">
                <div className="text-[11px] font-semibold text-slate-400 mb-1">Teaching results</div>
                <div className="space-y-2">
                  {teachingResults.applied_rule_results.map((r) => (
                    <div
                      key={`${r.action_index}-${r.action}`}
                      className={cn(
                        'rounded-md border p-2.5',
                        r.success ? 'border-emerald-900/50 bg-emerald-950/20' : 'border-red-900/50 bg-red-950/20'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[12px] font-semibold text-slate-200">
                            Action {r.action_index + 1}: {r.action}
                          </div>
                          <div className={cn('text-[11px] mt-1 whitespace-pre-wrap', r.success ? 'text-emerald-200/90' : 'text-red-200/90')}>
                            {r.message}
                          </div>
                        </div>
                        {r.success ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <AlertTriangle className="w-4 h-4 text-red-300" />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </motion.div>
  );
}

