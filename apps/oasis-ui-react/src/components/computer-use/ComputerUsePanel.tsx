/**
 * Computer-Use Panel — sidebar for goal + capture target + plan approval.
 *
 * Execution happens ENTIRELY server-side via the computer-use controller.
 * This panel handles:
 *   1. Capture target selection (entire screen vs specific window/app)
 *   2. Goal input → creates a backend session
 *   3. Plan review & approval (approve/reject buttons)
 *   4. Step-by-step approval when enabled
 *   5. Live progress tracking with screenshots
 *
 * Screenshots are taken natively via OasisScreenCapture.app — no browser
 * getDisplayMedia permission is needed. Mouse/keyboard control goes through
 * OasisComputerControl.app for dedicated macOS permissions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Monitor, Eye, Chrome, Puzzle,
  CheckCircle2, AlertTriangle, Loader2, ShieldAlert,
  ChevronDown, ChevronRight, Send, Shield, Settings2,
  SkipForward, Play, Pause, Ban, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { OASIS_BASE_URL } from '@/lib/constants';
import type { CuSession, CuPlanStep, CuSubStep, CuPolicy } from '@/lib/types';
import { CaptureTargetPicker, type CaptureTarget } from './CaptureTargetPicker';
const API = `${OASIS_BASE_URL}/api/v1/computer-use`;

/* ── Step status icon ──────────────────────────────────────────────────── */

function StepIcon({ status }: { status: CuPlanStep['status'] }) {
  switch (status) {
    case 'running':
      return (
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
          <Loader2 className="w-3.5 h-3.5 text-blue-400" />
        </motion.div>
      );
    case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    case 'failed': return <AlertTriangle className="w-3.5 h-3.5 text-red-400" />;
    case 'blocked': return <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />;
    case 'skipped': return <SkipForward className="w-3.5 h-3.5 text-slate-500" />;
    default: return <div className="w-3.5 h-3.5 rounded-full border border-slate-600" />;
  }
}

/* ── Policy Summary ────────────────────────────────────────────────────── */

function PolicySummary({ policy }: { policy: CuPolicy }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {policy.domain_blacklist.length > 0 && (
        <Badge variant="outline" className="text-[10px] border-red-800 text-red-300 py-0">
          <Shield className="w-2.5 h-2.5 mr-0.5 inline" />
          {policy.domain_blacklist.length} blocked domains
        </Badge>
      )}
      {policy.domain_whitelist.length > 0 && (
        <Badge variant="outline" className="text-[10px] border-emerald-800 text-emerald-300 py-0">
          {policy.domain_whitelist.length} allowed domains
        </Badge>
      )}
      <Badge variant="outline" className="text-[10px] border-slate-700 text-slate-400 py-0">
        Max {policy.max_steps} steps
      </Badge>
      <Badge variant="outline" className="text-[10px] border-slate-700 text-slate-400 py-0">
        {Math.floor(policy.max_duration_seconds / 60)}min timeout
      </Badge>
      {policy.require_step_approval && (
        <Badge variant="outline" className="text-[10px] border-blue-800 text-blue-300 py-0">
          Step-by-step
        </Badge>
      )}
    </div>
  );
}

/* ── Sub-step icon (smaller) ──────────────────────────────────────────── */

function SubStepIcon({ status }: { status: CuSubStep['status'] }) {
  switch (status) {
    case 'running':
      return (
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
          <Loader2 className="w-2.5 h-2.5 text-blue-400" />
        </motion.div>
      );
    case 'completed': return <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400/70" />;
    case 'failed': return <AlertTriangle className="w-2.5 h-2.5 text-red-400/70" />;
    default: return <div className="w-2 h-2 rounded-full border border-slate-700" />;
  }
}

/* ── Plan Step List (fixed height, auto-scroll, sub-steps) ────────────── */

interface PlanStepListProps {
  plan: CuPlanStep[];
  currentStep: number;
  sessionStatus: CuSession['status'];
  requireStepApproval: boolean;
  expandedStep: number | null;
  onToggleExpand: (index: number) => void;
  onStepApproval: (stepIndex: number, approved: boolean) => void;
}

function PlanStepList({
  plan,
  currentStep,
  sessionStatus,
  requireStepApproval,
  expandedStep,
  onToggleExpand,
  onStepApproval,
}: PlanStepListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Auto-scroll to the current/running step
  useEffect(() => {
    const runningIdx = plan.findIndex(s => s.status === 'running');
    const targetIdx = runningIdx >= 0 ? runningIdx : currentStep;
    const el = stepRefs.current.get(targetIdx);
    if (el && containerRef.current) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentStep, plan]);

  return (
    <div className="flex flex-col gap-1 mt-1">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider">
        {plan.filter(s => s.status === 'completed').length}/{plan.length} steps
      </div>
      <div
        ref={containerRef}
        className="max-h-[320px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
      >
        <div className="flex flex-col gap-0.5">
          {plan.map((step) => {
            const isCurrentPaused =
              sessionStatus === 'paused' &&
              requireStepApproval &&
              step.index === currentStep &&
              step.status === 'pending';

            return (
              <div
                key={step.index}
                ref={(el) => { if (el) stepRefs.current.set(step.index, el); }}
                className="flex flex-col"
              >
                <button
                  type="button"
                  onClick={() => onToggleExpand(step.index)}
                  className={cn(
                    'flex items-center gap-1.5 py-1.5 text-left hover:bg-slate-800/30 rounded px-1.5 transition-colors',
                    step.index === currentStep && sessionStatus === 'executing' && 'bg-blue-950/30 border-l-2 border-blue-500',
                    isCurrentPaused && 'bg-amber-900/20 border border-amber-800/40 rounded-lg',
                  )}
                >
                  <StepIcon status={step.status} />
                  <span className={cn(
                    'text-[10px] flex-1 truncate',
                    step.status === 'completed' ? 'text-slate-500' : 'text-slate-300',
                  )}>
                    {step.description}
                  </span>
                  {step.retry_count != null && step.retry_count > 0 && (
                    <Badge variant="outline" className="text-[8px] border-yellow-800 text-yellow-400 py-0">
                      retry {step.retry_count}
                    </Badge>
                  )}
                  {step.block_reason && (
                    <Badge variant="outline" className="text-[8px] border-amber-800 text-amber-400 py-0">blocked</Badge>
                  )}
                  {isCurrentPaused && (
                    <Badge variant="outline" className="text-[8px] border-amber-800 text-amber-300 py-0 animate-pulse">
                      needs approval
                    </Badge>
                  )}
                  {(step.sub_steps && step.sub_steps.length > 0) || step.output || step.screenshot ? (
                    expandedStep === step.index
                      ? <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
                      : <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
                  ) : null}
                </button>

                {/* Step-by-step approval buttons */}
                {isCurrentPaused && (
                  <div className="flex items-center gap-2 pl-6 py-1.5">
                    <Button
                      size="sm"
                      onClick={() => onStepApproval(step.index, true)}
                      className="bg-emerald-600 hover:bg-emerald-500 gap-1 text-[10px] h-6 px-2"
                    >
                      <ThumbsUp className="w-2.5 h-2.5" />
                      Approve Step
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onStepApproval(step.index, false)}
                      className="border-red-800 text-red-400 hover:bg-red-950/30 gap-1 text-[10px] h-6 px-2"
                    >
                      <ThumbsDown className="w-2.5 h-2.5" />
                      Skip
                    </Button>
                  </div>
                )}

                {/* Expanded: sub-steps + details */}
                <AnimatePresence>
                  {expandedStep === step.index && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      {/* Sub-steps */}
                      {step.sub_steps && step.sub_steps.length > 0 && (
                        <div className="pl-5 py-1 flex flex-col gap-0.5 border-l border-slate-800 ml-2 mb-1">
                          {step.sub_steps.map((sub) => (
                            <div key={sub.index} className="flex items-center gap-1.5 py-0.5 px-1">
                              <SubStepIcon status={sub.status} />
                              <span className={cn(
                                'text-[9px] flex-1 truncate',
                                sub.status === 'completed' ? 'text-slate-600' : 'text-slate-400',
                              )}>
                                {sub.description}
                              </span>
                              {sub.output && (
                                <span className="text-[8px] text-slate-600 truncate max-w-[100px]">
                                  {sub.output.slice(0, 50)}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Step details (screenshot, output, block reason) */}
                      {(step.output || step.screenshot || step.block_reason) && (
                        <div className="pl-6 pb-1">
                          {step.screenshot && (
                            <img
                              src={`data:image/jpeg;base64,${step.screenshot}`}
                              alt={`Step ${step.index} screenshot`}
                              className="rounded-lg border border-slate-700 max-w-full mb-1.5 opacity-90"
                            />
                          )}
                          {step.output && (
                            <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-words leading-relaxed mb-1">
                              {step.output.slice(0, 500)}
                            </pre>
                          )}
                          {step.block_reason && (
                            <div className="text-[10px] text-amber-400 mb-1">
                              Blocked: {step.block_reason}
                            </div>
                          )}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Main Panel ────────────────────────────────────────────────────────── */

interface ComputerUsePanelProps {
  onClose: () => void;
  /** Notify parent that an active computer-use session exists. */
  onScreenShareChange?: (isActive: boolean) => void;
  /** Pre-selected capture target from the picker dialog. */
  captureTarget?: { mode: string; target?: string; label?: string };
  /** Inject a message into the chat when the session completes. */
  addMessage?: (text: string, sender: 'assistant' | 'system') => void;
  /** Start App-level CU poller when a session begins executing (survives panel close). */
  onSessionExecuting?: (sessionId: string) => void;
}

export function ComputerUsePanel({
  onClose,
  onScreenShareChange,
  captureTarget: externalCaptureTarget,
  addMessage,
  onSessionExecuting,
}: ComputerUsePanelProps) {
  const { toast } = useToast();
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget | null>(
    externalCaptureTarget ? { mode: externalCaptureTarget.mode as CaptureTarget['mode'], target: externalCaptureTarget.target, label: externalCaptureTarget.label } : null,
  );
  const [showPicker, setShowPicker] = useState(!externalCaptureTarget);
  const [goal, setGoal] = useState('');
  const [stepApproval, setStepApproval] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [activeSession, setActiveSession] = useState<CuSession | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [chromeBridgeConnected, setChromeBridgeConnected] = useState<boolean | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync external capture target, or show picker if none provided.
  // AnimatePresence may reuse the component fiber across close/reopen cycles,
  // so useState initializers don't re-run — we need this effect to reset state.
  useEffect(() => {
    if (externalCaptureTarget) {
      setCaptureTarget({ mode: externalCaptureTarget.mode as CaptureTarget['mode'], target: externalCaptureTarget.target, label: externalCaptureTarget.label });
      setShowPicker(false);
    } else {
      setShowPicker(true);
    }
  }, [externalCaptureTarget]);

  // Notify parent when a non-terminal session is active
  useEffect(() => {
    const isActive = !!activeSession && !['completed', 'failed', 'cancelled'].includes(activeSession.status);
    onScreenShareChange?.(isActive);
  }, [activeSession?.session_id, activeSession?.status, onScreenShareChange]);

  /* ── Persist active session ID to localStorage ── */
  useEffect(() => {
    if (activeSession) {
      localStorage.setItem('cu-active-session', activeSession.session_id);
    }
  }, [activeSession?.session_id]);

  /* ── Check Chrome Bridge extension status ── */
  useEffect(() => {
    const check = async () => {
      try {
        // Dev-agent runs natively on port 8008 (same host as the browser)
        const devAgentUrl = `${window.location.protocol}//${window.location.hostname}:8008`;
        const res = await axios.get(`${devAgentUrl}/health`, { timeout: 3000 });
        setChromeBridgeConnected(res.data?.chrome_bridge === true);
      } catch { setChromeBridgeConnected(null); }
    };
    check();
  }, []);

  /* ── Recover session on mount (tab switch / panel reopen) ── */
  useEffect(() => {
    const recover = async () => {
      // 1. Try localStorage first (specific session we were tracking)
      const savedId = localStorage.getItem('cu-active-session');
      if (savedId) {
        try {
          const res = await axios.get(`${API}/sessions/${savedId}`, { timeout: 5000 });
          const session = res.data as CuSession;
          if (!['completed', 'failed', 'cancelled'].includes(session.status)) {
            setActiveSession(session);
            return;
          }
          // Terminal session — show it briefly so user can see the result
          setActiveSession(session);
          return;
        } catch { /* session gone from backend, try active endpoint */ }
      }

      // 2. Fallback: ask backend for any active session
      try {
        const res = await axios.get(`${API}/sessions/active`, { timeout: 5000 });
        if (res.data?.session) {
          setActiveSession(res.data.session);
        }
      } catch { /* no active session */ }
    };
    recover();
  }, []); // Run once on mount

  /* ── Poll active session ── */
  const pollSession = useCallback(async (id: string) => {
    try {
      const res = await axios.get(`${API}/sessions/${id}`, { timeout: 5000 });
      setActiveSession(res.data);
      if (['completed', 'failed', 'cancelled'].includes(res.data.status)) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (activeSession && ['planning', 'executing', 'paused'].includes(activeSession.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => pollSession(activeSession.session_id), 2000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [activeSession?.session_id, activeSession?.status, pollSession]);

  /* ── Auto-expand the currently running/active step ── */
  useEffect(() => {
    if (!activeSession) return;
    const runningIdx = activeSession.plan.findIndex(s => s.status === 'running');
    const targetIdx = runningIdx >= 0 ? runningIdx : activeSession.current_step;
    if (targetIdx >= 0 && targetIdx < activeSession.plan.length && expandedStep !== targetIdx) {
      setExpandedStep(targetIdx);
    }
  }, [activeSession?.current_step, activeSession?.plan]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Frame pushing removed — backend captures screenshots on demand via dev-agent pyautogui ── */

  /* ── Emergency pause hotkey (default: Cmd+Escape / Ctrl+Escape) ── */
  const [panicKey, setPanicKey] = useState<string>(localStorage.getItem('cu-panic-key') || 'meta+Escape');
  const panicKeyRef = useRef(panicKey);
  panicKeyRef.current = panicKey;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const parts = panicKeyRef.current.split('+');
      const key = parts[parts.length - 1];
      const needsMeta = parts.includes('meta') || parts.includes('command');
      const needsCtrl = parts.includes('ctrl');
      const needsShift = parts.includes('shift');

      const keyMatch = e.key === key || e.key.toLowerCase() === key.toLowerCase() || e.code === key;
      const metaMatch = !needsMeta || e.metaKey;
      const ctrlMatch = !needsCtrl || e.ctrlKey;
      const shiftMatch = !needsShift || e.shiftKey;

      if (keyMatch && metaMatch && ctrlMatch && shiftMatch && activeSession?.status === 'executing') {
        e.preventDefault();
        e.stopPropagation();
        axios.post(`${API}/sessions/${activeSession.session_id}/pause`).catch(() => {});
        toast({ title: 'EMERGENCY PAUSE', description: 'Agent paused. You can resume or cancel.', variant: 'destructive' });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeSession?.session_id, activeSession?.status, toast]);

  const updatePanicKey = (newKey: string) => {
    setPanicKey(newKey);
    localStorage.setItem('cu-panic-key', newKey);
  };

  /* ── Create session (stays in sidebar; no chat involved) ── */
  const handleCreate = async () => {
    if (!goal.trim() || !captureTarget) return;

    setIsCreating(true);
    try {
      let currentFrame: string | null = null;
      try {
        // Focus target window if needed
        if (captureTarget.mode === 'window' && captureTarget.target) {
          await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/execute`, {
            tool: 'computer_action',
            action: 'focus_window',
            text: captureTarget.target,
          }, { timeout: 5000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
        }
        const ssRes = await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/execute`, {
          tool: 'computer_action',
          action: 'screenshot',
        }, { timeout: 15000 });
        currentFrame = ssRes.data?.screenshot || null;
      } catch { /* dev-agent screenshot not available — create session without image */ }
      const res = await axios.post(`${API}/sessions`, {
        goal: goal.trim(),
        policy: stepApproval ? { require_step_approval: true } : undefined,
        screen_image: currentFrame || undefined,
        capture_target: { mode: captureTarget.mode, target: captureTarget.target },
      });
      const sessionId = res.data.session_id;
      const full = await axios.get(`${API}/sessions/${sessionId}`);
      setActiveSession(full.data);
      setGoal('');
      toast({ title: 'Plan Generating', description: 'The agent is drafting a plan. You can review and approve it below.' });
    } catch (e: unknown) {
      toast({
        title: 'Failed',
        description: axios.isAxiosError(e) ? e.response?.data?.message || e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setIsCreating(false);
    }
  };

  /* ── Approve the plan ── */
  const handleApprove = async () => {
    if (!activeSession) return;
    try {
      await axios.post(`${API}/sessions/${activeSession.session_id}/approve`, {
        session_id: activeSession.session_id,
        grant_vision: true,
      });
      toast({ title: 'Plan Approved', description: 'Execution started. Watch the steps below.' });
      // Start App-level poller so step progress appears in chat even if panel is closed
      onSessionExecuting?.(activeSession.session_id);
      pollSession(activeSession.session_id);
    } catch (e: unknown) {
      toast({
        title: 'Approve Failed',
        description: axios.isAxiosError(e) ? e.response?.data?.message || e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  /* ── Reject (cancel) the plan ── */
  const handleReject = async () => {
    if (!activeSession) return;
    try {
      await axios.delete(`${API}/sessions/${activeSession.session_id}`);
      toast({ title: 'Plan Rejected', description: 'Session cancelled.' });
      setActiveSession(null);
      localStorage.removeItem('cu-active-session');
    } catch { /* ignore */ }
  };

  /* ── Step-by-step approve/reject ── */
  const handleStepApproval = async (stepIndex: number, approved: boolean) => {
    if (!activeSession) return;
    try {
      await axios.post(`${API}/sessions/${activeSession.session_id}/step-approve`, {
        session_id: activeSession.session_id,
        step_index: stepIndex,
        approved,
      });
      pollSession(activeSession.session_id);
    } catch (e: unknown) {
      toast({
        title: 'Step Approval Failed',
        description: axios.isAxiosError(e) ? e.response?.data?.message || e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  /* ── Pause / Resume ── */
  const handlePause = async () => {
    if (!activeSession) return;
    try {
      await axios.post(`${API}/sessions/${activeSession.session_id}/pause`);
      pollSession(activeSession.session_id);
    } catch { /* ignore */ }
  };

  const handleResume = async () => {
    if (!activeSession) return;
    try {
      await axios.post(`${API}/sessions/${activeSession.session_id}/resume`);
      pollSession(activeSession.session_id);
    } catch { /* ignore */ }
  };

  /* ── Send steering feedback mid-execution ── */
  const [feedback, setFeedback] = useState('');
  const handleSendFeedback = async () => {
    if (!activeSession || !feedback.trim()) return;
    try {
      await axios.post(`${API}/sessions/${activeSession.session_id}/feedback`, {
        message: feedback.trim(),
      });
      toast({ title: 'Feedback sent', description: 'The agent will incorporate your guidance.' });
      setFeedback('');
    } catch { /* ignore */ }
  };

  /* ── Cancel ── */
  const handleCancel = async () => {
    if (!activeSession) return;
    try {
      await axios.delete(`${API}/sessions/${activeSession.session_id}`);
      toast({ title: 'Cancelled', description: 'Session cancelled.' });
      setActiveSession(null);
      localStorage.removeItem('cu-active-session');
    } catch { /* ignore */ }
  };

  /* ── Status badge ── */
  const statusColor = (s: CuSession['status']) => {
    switch (s) {
      case 'planning': return 'border-blue-800 text-blue-300';
      case 'awaiting_approval': return 'border-amber-800 text-amber-300';
      case 'executing': return 'border-emerald-800 text-emerald-300';
      case 'paused': return 'border-yellow-800 text-yellow-300';
      case 'completed': return 'border-emerald-800 text-emerald-300';
      case 'failed': return 'border-red-800 text-red-300';
      case 'cancelled': return 'border-slate-700 text-slate-400';
    }
  };

  const isTerminal = activeSession && ['completed', 'failed', 'cancelled'].includes(activeSession.status);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 420, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="h-full border-r border-slate-800 bg-[#0a0f1a] flex flex-col overflow-hidden flex-shrink-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <Monitor className="w-5 h-5 text-purple-400" />
          <h2 className="text-sm font-semibold text-slate-200">Computer Use</h2>
        </div>
        <div className="flex items-center gap-2">
          {activeSession && !['completed', 'failed', 'cancelled'].includes(activeSession.status) && (
            <Badge variant="outline" className="text-[10px] border-emerald-800 text-emerald-300 py-0 gap-0.5 animate-pulse">
              <Eye className="w-2.5 h-2.5" /> Active
            </Badge>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} className="text-slate-400 hover:text-white w-7 h-7">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-5 py-4">
        <div className="flex flex-col gap-4">

          {/* ── Capture Target Picker ── */}
          <CaptureTargetPicker
            open={showPicker}
            onSelect={(t) => { setCaptureTarget(t); setShowPicker(false); }}
            onCancel={() => { if (!captureTarget) onClose(); else setShowPicker(false); }}
          />

          {/* ── Capture Target Summary ── */}
          {captureTarget ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex items-center gap-3">
              <Monitor className="w-4 h-4 text-purple-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-[11px] text-slate-400">Sharing: </span>
                <span className="text-[11px] text-slate-200 font-medium">
                  {captureTarget.label || (captureTarget.mode === 'full_screen' ? 'Entire Screen' : captureTarget.target || 'Window')}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowPicker(true)}
                className="text-[10px] text-slate-400 hover:text-white h-6 px-2"
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/20 p-4 flex flex-col items-center gap-2">
              <Monitor className="w-6 h-6 text-slate-600" />
              <span className="text-[11px] text-slate-500">Select what to share first</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowPicker(true)}
                className="border-purple-800 text-purple-300 hover:bg-purple-950/30 text-[11px] h-7"
              >
                Choose Screen or Window
              </Button>
            </div>
          )}

          {/* ── Chrome Bridge Extension Status ── */}
          {chromeBridgeConnected === false && (
            <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-3 flex items-start gap-2.5">
              <Puzzle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-amber-300 mb-1">Chrome Bridge extension not detected</div>
                <div className="text-[10px] text-amber-300/70 leading-relaxed">
                  Install the extension for reliable page text extraction. Without it, computer-use
                  falls back to OCR which is slow and error-prone.
                </div>
                <div className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
                  Chrome &rarr; <span className="text-slate-400">chrome://extensions</span> &rarr; Developer mode &rarr;
                  Load unpacked &rarr; <span className="text-slate-400 font-mono">extensions/oasis-chrome-bridge</span>
                </div>
              </div>
            </div>
          )}
          {chromeBridgeConnected === true && (
            <div className="rounded-xl border border-emerald-800/30 bg-emerald-950/10 p-2.5 flex items-center gap-2">
              <Chrome className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[10px] text-emerald-300/80">Chrome Bridge connected</span>
            </div>
          )}

          {/* ── Emergency Pause Hotkey ── */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
              <span className="text-[11px] text-slate-400">Emergency Pause</span>
            </div>
            <div className="flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 border border-slate-700 rounded text-amber-300">
                {panicKey.replace('meta', '\u2318').replace('ctrl', 'Ctrl').replace('+', ' + ')}
              </kbd>
              <select
                value={panicKey}
                onChange={(e) => updatePanicKey(e.target.value)}
                className="text-[10px] bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-400 focus:outline-none"
              >
                <option value="meta+Escape">{'\u2318'} + Esc</option>
                <option value="ctrl+Escape">Ctrl + Esc</option>
                <option value="meta+shift+Escape">{'\u2318'} + Shift + Esc</option>
                <option value="meta+.">{'⌘'} + .</option>
              </select>
            </div>
          </div>

          {/* ── Step 2: Goal Input (only when no active session or terminal) ── */}
          {(!activeSession || isTerminal) && (
            <div className="flex flex-col gap-3">
              <div className="text-[11px] text-slate-500 leading-relaxed">
                Describe what you want the agent to accomplish on your screen.
                The agent will draft a plan for your approval, then execute it.
              </div>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g., Go to github.com/myrepo and check the latest open issues..."
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 resize-none focus:outline-none focus:border-purple-700 min-h-[80px]"
                rows={3}
              />
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stepApproval}
                    onChange={(e) => setStepApproval(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-800 text-purple-500 focus:ring-purple-800 w-3.5 h-3.5"
                  />
                  Step-by-step approval
                </label>
              </div>
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!goal.trim() || !captureTarget || isCreating}
                className={cn(
                  'self-start gap-1.5',
                  goal.trim() && captureTarget
                    ? 'bg-purple-600 hover:bg-purple-500'
                    : 'bg-slate-700 text-slate-400 cursor-not-allowed',
                )}
              >
                {isCreating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                {isCreating ? 'Creating...' : 'Create Plan'}
              </Button>
            </div>
          )}

          {/* ── Policy ── */}
          <button
            type="button"
            onClick={() => setShowPolicy(!showPolicy)}
            className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200"
          >
            <Settings2 className="w-3 h-3" />
            Security Policy
            {showPolicy ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
          <AnimatePresence>
            {showPolicy && activeSession?.policy && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <PolicySummary policy={activeSession.policy} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Active session tracker ── */}
          {activeSession && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-3 flex flex-col gap-3">
              {/* Status header */}
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={cn('text-[10px] py-0 shrink-0', statusColor(activeSession.status))}>
                  {activeSession.status.replace('_', ' ')}
                </Badge>
                <span className="text-[10px] text-slate-500 font-mono truncate">{activeSession.session_id}</span>
              </div>
              <div className="text-[11px] text-slate-400 truncate">{activeSession.goal}</div>

              {/* ── APPROVE / REJECT buttons (when awaiting_approval) ── */}
              {activeSession.status === 'awaiting_approval' && (
                <div className="flex flex-col gap-2 mt-1">
                  <div className="text-[11px] text-amber-300 font-medium">
                    Review the plan below, then approve or reject:
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={handleApprove}
                      className="bg-emerald-600 hover:bg-emerald-500 gap-1 text-xs"
                    >
                      <ThumbsUp className="w-3 h-3" />
                      Approve & Execute
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleReject}
                      className="border-red-800 text-red-400 hover:bg-red-950/30 gap-1 text-xs"
                    >
                      <ThumbsDown className="w-3 h-3" />
                      Reject
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Pause / Resume / Cancel controls (when executing or paused) ── */}
              {(activeSession.status === 'executing' || activeSession.status === 'paused') && (
                <div className="flex items-center gap-2">
                  {activeSession.status === 'executing' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handlePause}
                        className="border-yellow-800 text-yellow-400 hover:bg-yellow-950/30 gap-1 text-xs"
                      >
                        <Pause className="w-3 h-3" />
                        Pause
                      </Button>
                      <kbd className="px-1.5 py-0.5 text-[9px] font-mono bg-red-950/50 border border-red-800 rounded text-red-300 animate-pulse">
                        {panicKey.replace('meta', '\u2318').replace('ctrl', 'Ctrl').replace('+', '+')}
                      </kbd>
                    </>
                  )}
                  {activeSession.status === 'paused' && !activeSession.policy.require_step_approval && (
                    <Button
                      size="sm"
                      onClick={handleResume}
                      className="bg-emerald-600 hover:bg-emerald-500 gap-1 text-xs"
                    >
                      <Play className="w-3 h-3" />
                      Resume
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCancel}
                    className="border-red-800 text-red-400 hover:bg-red-950/30 gap-1 text-xs"
                  >
                    <Ban className="w-3 h-3" />
                    Cancel
                  </Button>
                </div>
              )}

              {/* ── Steering input (during execution or paused) ── */}
              {(activeSession.status === 'executing' || activeSession.status === 'paused') && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSendFeedback(); }}
                    placeholder="Steer the agent... (e.g. 'click on the profile icon instead')"
                    className="flex-1 bg-slate-900/50 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-600"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendFeedback}
                    disabled={!feedback.trim()}
                    className="bg-blue-600 hover:bg-blue-500 text-xs px-2 py-1 h-auto"
                  >
                    <Send className="w-3 h-3" />
                  </Button>
                </div>
              )}

              {/* ── Step list (fixed height, auto-scroll) ── */}
              {activeSession.plan.length > 0 && (
                <PlanStepList
                  plan={activeSession.plan}
                  currentStep={activeSession.current_step}
                  sessionStatus={activeSession.status}
                  requireStepApproval={activeSession.policy.require_step_approval}
                  expandedStep={expandedStep}
                  onToggleExpand={(idx) => setExpandedStep(expandedStep === idx ? null : idx)}
                  onStepApproval={handleStepApproval}
                />
              )}

              {/* Live screenshot from latest completed step */}
              {activeSession.live_screenshot && activeSession.status === 'executing' && (
                <div className="mt-1">
                  <div className="text-[10px] text-slate-500 mb-1">Live view:</div>
                  <img
                    src={`data:image/jpeg;base64,${activeSession.live_screenshot}`}
                    alt="Live screen"
                    className="rounded-lg border border-slate-700 max-w-full opacity-80"
                  />
                </div>
              )}

              {/* Error display */}
              {activeSession.error && (
                <div className="text-[10px] text-red-400 flex items-start gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{activeSession.error}</span>
                </div>
              )}

              {/* Terminal state: allow new session */}
              {isTerminal && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setActiveSession(null); localStorage.removeItem('cu-active-session'); }}
                  className="self-start border-slate-700 text-slate-400 hover:text-slate-200 gap-1 text-xs mt-1"
                >
                  New Task
                </Button>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </motion.div>
  );
}
