/**
 * Mobile Computer Use — live streaming view of the desktop screen.
 *
 * Polls the computer-use session for status and live screenshots.
 * Supports:
 *   - Session creation with goal
 *   - Live screenshot streaming (polling every 2s)
 *   - Plan display with step progress
 *   - Plan approval/rejection
 *   - Fullscreen mode for the screenshot view
 *   - Session pause/cancel
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Monitor, X, Maximize2, Minimize2, Send, Check, XCircle,
  Pause, Play, Ban, Loader2, Eye, ChevronDown, ChevronRight,
} from 'lucide-react';

interface PlanStep {
  index: number;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
  output?: string;
  screenshot?: string;
}

interface CuSession {
  session_id: string;
  goal: string;
  status: 'planning' | 'awaiting_approval' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';
  plan: PlanStep[];
  current_step: number;
  live_screenshot?: string;
  error?: string;
}

interface MobileComputerUseProps {
  tunnelUrl: string;
  onClose: () => void;
}

export function MobileComputerUse({ tunnelUrl, onClose }: MobileComputerUseProps) {
  const [session, setSession] = useState<CuSession | null>(null);
  const [goal, setGoal] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const relayUrl = `${tunnelUrl}/relay`;

  // Poll for session status
  const pollSession = useCallback(async (sessionId?: string) => {
    try {
      const url = sessionId
        ? `${relayUrl}/computer-use/session?session_id=${sessionId}`
        : `${relayUrl}/computer-use/session`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      // The active endpoint wraps in { session: ... }
      const sess = data.session || data;
      if (sess?.session_id) {
        setSession(sess);
        // Stop polling for terminal states
        if (['completed', 'failed', 'cancelled'].includes(sess.status) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch { /* ignore */ }
  }, [relayUrl]);

  // On mount, check for active session
  useEffect(() => {
    pollSession();
  }, [pollSession]);

  // Start polling when session is active
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (session && !['completed', 'failed', 'cancelled'].includes(session.status)) {
      pollRef.current = setInterval(() => pollSession(session.session_id), 2000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [session?.session_id, session?.status, pollSession]);

  // Auto-expand running step
  useEffect(() => {
    if (!session) return;
    const runningIdx = session.plan.findIndex(s => s.status === 'running');
    if (runningIdx >= 0) setExpandedStep(runningIdx);
  }, [session?.plan]);

  // Create session
  const handleCreate = async () => {
    if (!goal.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      const res = await fetch(`${relayUrl}/screen-share/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim() }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (data.session_id) {
        setGoal('');
        // Start polling immediately
        pollSession(data.session_id);
      } else {
        setError(data.error || 'Failed to create session');
      }
    } catch (e: any) {
      setError(e.message || 'Failed to create session');
    } finally {
      setIsCreating(false);
    }
  };

  // Approve plan
  const handleApprove = async () => {
    if (!session) return;
    try {
      await fetch(`${relayUrl}/computer-use/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id }),
        signal: AbortSignal.timeout(10000),
      });
      pollSession(session.session_id);
    } catch { /* ignore */ }
  };

  // Cancel session
  const handleCancel = async () => {
    if (!session) return;
    try {
      await fetch(`${relayUrl}/computer-use/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id }),
        signal: AbortSignal.timeout(10000),
      });
      setSession(null);
    } catch { /* ignore */ }
  };

  // Pause (emergency stop)
  const handlePause = async () => {
    if (!session) return;
    try {
      await fetch(`${relayUrl}/computer-use/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id }),
        signal: AbortSignal.timeout(10000),
      });
      pollSession(session.session_id);
    } catch { /* ignore */ }
  };

  // Resume
  const handleResume = async () => {
    if (!session) return;
    try {
      await fetch(`${relayUrl}/computer-use/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id }),
        signal: AbortSignal.timeout(10000),
      });
      pollSession(session.session_id);
    } catch { /* ignore */ }
  };

  // Send steering feedback
  const [feedback, setFeedback] = useState('');
  const handleSendFeedback = async () => {
    if (!session || !feedback.trim()) return;
    try {
      await fetch(`${relayUrl}/computer-use/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, message: feedback.trim() }),
        signal: AbortSignal.timeout(10000),
      });
      setFeedback('');
    } catch { /* ignore */ }
  };

  // New task
  const handleNewTask = () => {
    setSession(null);
    setGoal('');
    setFeedback('');
    setError(null);
  };

  const isTerminal = session && ['completed', 'failed', 'cancelled'].includes(session.status);
  const statusColor = (s: CuSession['status']) => {
    switch (s) {
      case 'planning': return 'bg-blue-500/20 text-blue-300 border-blue-800';
      case 'awaiting_approval': return 'bg-amber-500/20 text-amber-300 border-amber-800';
      case 'executing': return 'bg-emerald-500/20 text-emerald-300 border-emerald-800';
      case 'paused': return 'bg-yellow-500/20 text-yellow-300 border-yellow-800';
      case 'completed': return 'bg-emerald-500/20 text-emerald-300 border-emerald-800';
      case 'failed': return 'bg-red-500/20 text-red-300 border-red-800';
      case 'cancelled': return 'bg-slate-500/20 text-slate-400 border-slate-700';
    }
  };

  // Fullscreen screenshot view
  if (isFullscreen && session?.live_screenshot) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 bg-black/80">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-[10px] border ${statusColor(session.status)}`}>
              {session.status.replace('_', ' ')}
            </span>
            <span className="text-[10px] text-slate-400">
              Step {session.current_step + 1}/{session.plan.length}
            </span>
          </div>
          <button
            onClick={() => setIsFullscreen(false)}
            className="p-1.5 rounded-lg bg-slate-800 text-white"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-2 overflow-auto">
          <img
            src={`data:image/jpeg;base64,${session.live_screenshot}`}
            alt="Desktop screen"
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        </div>
        {/* Controls overlay at bottom */}
        {session.status === 'executing' && (
          <div className="flex justify-center gap-3 p-3 bg-black/80">
            <button
              onClick={handleCancel}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-900/50 border border-red-800 text-red-300 text-xs"
            >
              <Ban className="w-3.5 h-3.5" />
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#030712]">
      {/* Header */}
      <header className="h-12 border-b border-slate-800 flex items-center justify-between px-4 bg-[#0a0f1a] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-purple-400" />
          <h2 className="text-sm font-semibold text-slate-200">Computer Use</h2>
          {session && !isTerminal && (
            <span className={`px-1.5 py-0.5 rounded text-[9px] border ${statusColor(session.status)}`}>
              {session.status.replace('_', ' ')}
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-4">

          {/* Live Screenshot Stream */}
          {session?.live_screenshot && (
            <div className="relative rounded-xl border border-slate-800 overflow-hidden">
              <img
                src={`data:image/jpeg;base64,${session.live_screenshot}`}
                alt="Desktop screen"
                className="w-full object-contain rounded-xl"
              />
              {/* Fullscreen button */}
              <button
                onClick={() => setIsFullscreen(true)}
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white hover:bg-black/80 transition-colors"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              {/* Status overlay */}
              {session.status === 'executing' && (
                <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/60">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[10px] text-emerald-300">
                    Step {session.current_step + 1}/{session.plan.length}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* No session — Goal input */}
          {(!session || isTerminal) && (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Describe what you want the agent to do on your desktop.
                Screenshots are captured natively — no browser permission needed.
              </p>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g., Open Chrome and check GitHub issues..."
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 resize-none focus:outline-none focus:border-purple-700 min-h-[80px]"
                rows={3}
              />
              <button
                onClick={handleCreate}
                disabled={!goal.trim() || isCreating}
                className="self-start flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isCreating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                {isCreating ? 'Creating...' : 'Create Plan'}
              </button>
              {error && (
                <p className="text-[11px] text-red-400">{error}</p>
              )}
            </div>
          )}

          {/* Awaiting approval */}
          {session?.status === 'awaiting_approval' && (
            <div className="rounded-xl border border-amber-800/40 bg-amber-900/20 p-3 flex flex-col gap-2">
              <p className="text-[11px] text-amber-300 font-medium">
                Review the plan below, then approve or reject:
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleApprove}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium"
                >
                  <Check className="w-3 h-3" />
                  Approve
                </button>
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-800 text-red-400 text-xs font-medium"
                >
                  <XCircle className="w-3 h-3" />
                  Reject
                </button>
              </div>
            </div>
          )}

          {/* Executing/paused controls */}
          {session && (session.status === 'executing' || session.status === 'paused') && (
            <div className="flex flex-col gap-2">
              {/* Warning banner */}
              {session.status === 'executing' && (
                <div className="bg-red-950/30 border border-red-800/40 rounded-lg p-2 text-center">
                  <span className="text-[10px] text-red-300">Agent is controlling the browser — avoid interacting</span>
                </div>
              )}
              {session.status === 'paused' && session.error && (
                <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-2">
                  <span className="text-[10px] text-amber-300">{session.error}</span>
                </div>
              )}

              {/* Steering input */}
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSendFeedback(); }}
                  placeholder="Steer the agent..."
                  className="flex-1 bg-slate-900/50 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-purple-600"
                />
                <button
                  onClick={handleSendFeedback}
                  disabled={!feedback.trim()}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium disabled:opacity-40"
                >
                  Send
                </button>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                {session.status === 'executing' ? (
                  <button
                    onClick={handlePause}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 text-white text-xs font-bold"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    EMERGENCY STOP
                  </button>
                ) : (
                  <button
                    onClick={handleResume}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Resume
                  </button>
                )}
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-800 text-red-400 text-xs font-medium"
                >
                  <Ban className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Plan steps */}
          {session && session.plan.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">Plan</span>
                <span className="text-[10px] text-slate-500">
                  {session.plan.filter(s => s.status === 'completed').length}/{session.plan.length} steps
                </span>
              </div>
              <div className="flex flex-col gap-0.5 max-h-[240px] overflow-y-auto">
                {session.plan.map((step) => (
                  <div key={step.index} className="flex flex-col">
                    <button
                      onClick={() => setExpandedStep(expandedStep === step.index ? null : step.index)}
                      className={`flex items-center gap-1.5 py-1.5 px-2 rounded-lg text-left transition-colors ${
                        step.status === 'running'
                          ? 'bg-blue-950/30 border-l-2 border-blue-500'
                          : 'hover:bg-slate-800/30'
                      }`}
                    >
                      {/* Step icon */}
                      {step.status === 'running' && <Loader2 className="w-3 h-3 text-blue-400 animate-spin shrink-0" />}
                      {step.status === 'completed' && <Check className="w-3 h-3 text-emerald-400 shrink-0" />}
                      {step.status === 'failed' && <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
                      {step.status === 'pending' && <div className="w-3 h-3 rounded-full border border-slate-600 shrink-0" />}
                      {step.status === 'skipped' && <div className="w-3 h-3 rounded-full bg-slate-600 shrink-0" />}
                      {step.status === 'blocked' && <div className="w-3 h-3 rounded-full bg-amber-600 shrink-0" />}

                      <span className={`text-[10px] flex-1 truncate ${
                        step.status === 'completed' ? 'text-slate-500' : 'text-slate-300'
                      }`}>
                        {step.description}
                      </span>
                      {(step.output || step.screenshot) && (
                        expandedStep === step.index
                          ? <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
                          : <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
                      )}
                    </button>
                    {/* Expanded details */}
                    {expandedStep === step.index && (step.output || step.screenshot) && (
                      <div className="pl-5 pb-2">
                        {step.screenshot && (
                          <img
                            src={`data:image/jpeg;base64,${step.screenshot}`}
                            alt={`Step ${step.index}`}
                            className="rounded-lg border border-slate-700 max-w-full mb-1 opacity-90"
                          />
                        )}
                        {step.output && (
                          <pre className="text-[9px] text-slate-500 whitespace-pre-wrap break-words">
                            {step.output.slice(0, 300)}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Session error */}
          {session?.error && (
            <div className="rounded-xl border border-red-800/40 bg-red-900/20 p-3">
              <p className="text-[11px] text-red-300">{session.error}</p>
            </div>
          )}

          {/* Terminal state — New Task button */}
          {isTerminal && (
            <button
              onClick={handleNewTask}
              className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-xs"
            >
              New Task
            </button>
          )}

          {/* Session goal display */}
          {session && !isTerminal && (
            <div className="text-[11px] text-slate-400 truncate">
              <Eye className="w-3 h-3 inline mr-1 text-slate-500" />
              {session.goal}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
