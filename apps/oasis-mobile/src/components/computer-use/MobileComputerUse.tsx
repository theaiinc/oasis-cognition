/**
 * Mobile Computer Use — Chat-centric UI.
 *
 * The CU session looks and feels like a chat conversation:
 *   - Agent actions appear as chat bubbles (left)
 *   - User steering/feedback appears as chat bubbles (right)
 *   - Unified input bar at the bottom (text + send + mic)
 *   - Live screenshot as collapsible preview at top
 *   - Plan approval inline as a card in the chat flow
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Monitor, X, Maximize2, Minimize2, Send, Check, XCircle,
  Pause, Play, Ban, Loader2, Eye, ChevronDown, ChevronUp,
  Mic, MicOff, Zap, Image,
} from 'lucide-react';
import type { VoiceChatState } from '../../hooks/useVoiceChat';

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
  summary?: string;
}

interface ChatMsg {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text: string;
  time: string;
  type?: 'step' | 'approval' | 'summary' | 'error' | 'screenshot' | 'text';
  screenshot?: string;
}

interface MobileComputerUseProps {
  tunnelUrl: string;
  voiceChat?: VoiceChatState;
  onClose: () => void;
}

// AbortSignal.timeout polyfill for older mobile browsers
function safeTimeout(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

let msgIdCounter = 0;
function nextMsgId() { return `msg_${++msgIdCounter}`; }

export function MobileComputerUse({ tunnelUrl, voiceChat, onClose }: MobileComputerUseProps) {
  const [session, setSession] = useState<CuSession | null>(null);
  const [input, setInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showScreenPreview, setShowScreenPreview] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [screenGranted, setScreenGranted] = useState(false);
  const [liveScreen, setLiveScreen] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [micPermission, setMicPermission] = useState<'unknown' | 'granted' | 'denied' | 'requesting'>('unknown');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const reportedStepsRef = useRef(0);
  const prevStatusRef = useRef<string | null>(null);
  const lastVoiceRef = useRef('');
  const micIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const micRecorderRef = useRef<MediaRecorder | null>(null);

  const relayUrl = `${tunnelUrl}/relay`;
  const isTerminal = session && ['completed', 'failed', 'cancelled'].includes(session.status);
  const isActive = session && ['executing', 'paused', 'planning', 'awaiting_approval'].includes(session.status);

  // Helpers
  const addMsg = useCallback((sender: ChatMsg['sender'], text: string, type?: ChatMsg['type'], screenshot?: string) => {
    setMessages(prev => [...prev, {
      id: nextMsgId(), sender, text, type,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      screenshot,
    }].slice(-100));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (micIntervalRef.current) clearInterval(micIntervalRef.current);
    };
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Screen access polling ──
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      // Skip during active CU session
      if (session && !['completed', 'failed', 'cancelled'].includes(session.status)) return;
      try {
        const statusRes = await fetch(`${tunnelUrl}/pair/status`).catch(() => null);
        if (statusRes?.ok) {
          const d = await statusRes.json();
          setScreenGranted(d.screen_share_granted === true);
          if (!d.screen_share_granted || stopped) return;
        }
        const ssRes = await fetch(`${relayUrl}/screenshot`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(() => null);
        if (ssRes?.ok && !stopped) {
          const d = await ssRes.json();
          if (d.screenshot) setLiveScreen(d.screenshot);
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { stopped = true; clearInterval(interval); };
  }, [tunnelUrl, relayUrl, session?.status]);

  // ── Session polling ──
  const pollSession = useCallback(async (sessionId?: string) => {
    try {
      const url = sessionId
        ? `${relayUrl}/computer-use/session?session_id=${sessionId}`
        : `${relayUrl}/computer-use/session`;
      const res = await fetch(url, { signal: safeTimeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      const sess = data.session || data;
      if (sess?.session_id) setSession(sess);
    } catch { /* ignore */ }
  }, [relayUrl]);

  useEffect(() => { pollSession(); }, [pollSession]);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (session && !['completed', 'failed', 'cancelled'].includes(session.status)) {
      pollRef.current = setInterval(() => pollSession(session.session_id), 2000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [session?.session_id, session?.status, pollSession]);

  // ── Session status changes → messages ──
  useEffect(() => {
    if (!session) { prevStatusRef.current = null; return; }
    const prev = prevStatusRef.current;
    prevStatusRef.current = session.status;

    // Auto-approve
    if (session.status === 'awaiting_approval' && autoApprove && prev !== 'awaiting_approval') {
      fetch(`${relayUrl}/computer-use/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id }),
      }).then(() => { addMsg('system', 'Plan auto-approved — executing...'); pollSession(session.session_id); }).catch(() => {});
    }

    // Status transitions
    if (session.status === 'awaiting_approval' && prev !== 'awaiting_approval') {
      addMsg('agent', `Plan ready with ${session.plan?.length || 0} steps. Review and approve?`, 'approval');
    }
    if (session.status === 'executing' && prev !== 'executing') {
      addMsg('system', 'Executing...');
    }
    if (session.status === 'paused' && prev !== 'paused') {
      addMsg('system', session.error || 'Session paused');
    }
    if (prev && !['completed', 'failed', 'cancelled'].includes(prev) && ['completed', 'failed', 'cancelled'].includes(session.status)) {
      if (session.summary) {
        addMsg('agent', session.summary, 'summary');
      } else if (session.status === 'failed') {
        addMsg('agent', `Failed: ${session.error || 'unknown error'}`, 'error');
      } else if (session.status === 'completed') {
        addMsg('agent', 'Task completed', 'summary');
      }
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
  }, [session?.status, autoApprove, addMsg, relayUrl, pollSession]);

  // ── Step completions → messages ──
  useEffect(() => {
    if (!session) return;
    reportedStepsRef.current = 0; // reset on session_id change handled by dep
  }, [session?.session_id]);

  useEffect(() => {
    if (!session) return;
    const completed = session.plan.filter(s => s.status === 'completed' || s.status === 'failed');
    if (completed.length > reportedStepsRef.current) {
      const newSteps = completed.slice(reportedStepsRef.current);
      for (const s of newSteps) {
        const icon = s.status === 'completed' ? '✓' : '✗';
        const out = s.output ? ` — ${s.output.split('\n')[0].slice(0, 80)}` : '';
        addMsg('agent', `${icon} ${s.description || s.action}${out}`, 'step');
      }
      reportedStepsRef.current = completed.length;
    }
  }, [session?.plan, addMsg]);

  // ── Voice transcript → messages ──
  useEffect(() => {
    if (!voiceChat?.liveTranscript || !session) return;
    const t = voiceChat.liveTranscript.trim();
    if (t && t !== lastVoiceRef.current && t.length > 3) {
      const prev = lastVoiceRef.current;
      lastVoiceRef.current = t;
      if (prev && (t.includes(prev) || prev.includes(t))) return;
      addMsg('user', `🎤 ${t}`);
    }
  }, [voiceChat?.liveTranscript, session, addMsg]);

  // ── Actions ──
  const handleSend = async () => {
    if (!input.trim()) return;
    const msg = input.trim();
    setInput('');

    if (!session || isTerminal) {
      // Create new session
      addMsg('user', msg);
      setIsCreating(true);
      try {
        const res = await fetch(`${relayUrl}/screen-share/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: msg }),
        });
        const data = await res.json();
        if (data.session_id) {
          setSession({ session_id: data.session_id, goal: msg, status: 'planning', plan: [], current_step: 0 } as CuSession);
          addMsg('system', 'Creating plan...');
          pollSession(data.session_id);
        } else {
          addMsg('system', `Error: ${data.error || 'Failed to create session'}`, 'error');
        }
      } catch (e: any) {
        addMsg('system', `Error: ${e.message}`, 'error');
      }
      setIsCreating(false);
      return;
    }

    if (isTerminal) {
      // Follow up on completed/failed session
      addMsg('user', `Follow-up: ${msg}`);
      try {
        const res = await fetch(`${relayUrl}/computer-use/follow-up`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: session.session_id, message: msg }),
        });
        if (res.ok) {
          setSession(prev => prev ? { ...prev, status: 'executing' as any } : prev);
          addMsg('system', 'Session reopened — continuing...');
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = setInterval(() => pollSession(session.session_id), 2000);
          setTimeout(() => pollSession(session.session_id), 1500);
        } else {
          addMsg('system', 'Follow-up failed', 'error');
        }
      } catch { addMsg('system', 'Follow-up error', 'error'); }
      return;
    }

    // Steering feedback during execution
    addMsg('user', msg);
    try {
      await fetch(`${relayUrl}/computer-use/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, message: msg }),
      });
    } catch { /* ignore */ }
  };

  const handleApprove = async () => {
    if (!session) return;
    try {
      await fetch(`${relayUrl}/computer-use/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id }),
      });
      addMsg('system', 'Plan approved — executing...');
      pollSession(session.session_id);
    } catch { /* ignore */ }
  };

  const handlePause = async () => {
    if (!session) return;
    await fetch(`${relayUrl}/computer-use/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id }),
    }).catch(() => {});
    pollSession(session.session_id);
  };

  const handleResume = async () => {
    if (!session) return;
    await fetch(`${relayUrl}/computer-use/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id }),
    }).catch(() => {});
    pollSession(session.session_id);
  };

  const handleCancel = async () => {
    if (!session) return;
    await fetch(`${relayUrl}/computer-use/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id }),
    }).catch(() => {});
    setSession(null);
    addMsg('system', 'Session cancelled');
  };

  const handleNewTask = () => {
    setSession(null);
    setInput('');
    lastVoiceRef.current = '';
    reportedStepsRef.current = 0;
  };

  // Screenshot image for preview
  const screenImage = session?.live_screenshot || liveScreen;

  // ── Fullscreen screenshot view ──
  if (isFullscreen && screenImage) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 bg-black/80">
          {session ? (
            <span className="text-[10px] text-slate-400">
              Step {(session.current_step || 0) + 1}/{session.plan?.length || 0}
            </span>
          ) : (
            <span className="text-[10px] text-emerald-300 flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /> Screen shared
            </span>
          )}
          <button onClick={() => setIsFullscreen(false)} className="p-1.5 rounded-lg bg-slate-800 text-white">
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto" style={{ touchAction: 'pan-x pan-y pinch-zoom' }}>
          <img src={`data:image/jpeg;base64,${screenImage}`} alt="Screen" className="min-w-[200vw] object-contain" />
        </div>
      </div>
    );
  }

  // ── Input placeholder ──
  const placeholder = !session || isTerminal
    ? 'Describe what you want the agent to do...'
    : session.status === 'executing'
      ? 'Steer the agent...'
      : session.status === 'paused'
        ? 'Send instructions...'
        : 'Type a message...';

  // ── Main chat UI ──
  return (
    <div className="h-full flex flex-col bg-[#030712]">
      {/* Header */}
      <header className="h-11 border-b border-slate-800 flex items-center justify-between px-3 bg-[#0a0f1a] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Monitor className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-xs font-semibold text-slate-200">Computer Use</span>
          {session && (
            <span className={`px-1.5 py-0.5 rounded text-[8px] font-medium ${
              session.status === 'executing' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-800' :
              session.status === 'paused' ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-800' :
              session.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-800' :
              session.status === 'failed' ? 'bg-red-500/10 text-red-400 border border-red-800' :
              'bg-slate-500/10 text-slate-400 border border-slate-700'
            }`}>
              {session.status.replace('_', ' ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {session?.status === 'executing' && (
            <button onClick={handlePause} className="px-2 py-1 rounded bg-red-600 text-white text-[9px] font-bold">
              STOP
            </button>
          )}
          {session?.status === 'paused' && (
            <button onClick={handleResume} className="px-2 py-1 rounded bg-emerald-600 text-white text-[9px] font-bold">
              Resume
            </button>
          )}
          {isActive && (
            <button onClick={handleCancel} className="p-1 rounded text-slate-500 hover:text-red-400">
              <Ban className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded text-slate-500 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Executing warning banner */}
      {session?.status === 'executing' && (
        <div className="bg-red-950/30 border-b border-red-800/30 px-3 py-1.5 text-center">
          <span className="text-[9px] text-red-300">Agent controlling browser — avoid interacting</span>
        </div>
      )}

      {/* Collapsible screen preview */}
      {screenImage && (
        <div className="border-b border-slate-800 bg-slate-900/30">
          <button
            onClick={() => setShowScreenPreview(!showScreenPreview)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[9px] text-slate-500"
          >
            <span className="flex items-center gap-1"><Image className="w-3 h-3" /> Screen</span>
            {showScreenPreview ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showScreenPreview && (
            <div className="relative px-3 pb-2">
              <img
                src={`data:image/jpeg;base64,${screenImage}`}
                alt="Screen" className="w-full rounded-lg border border-slate-800"
              />
              <button
                onClick={() => setIsFullscreen(true)}
                className="absolute top-1 right-4 p-1 rounded bg-black/60 text-white"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-2">
          {/* Welcome message if no session */}
          {!session && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Monitor className="w-10 h-10 text-slate-700 mb-3" />
              <p className="text-xs text-slate-500 leading-relaxed max-w-[240px]">
                Tell the agent what to do on your desktop. It will create a plan, execute it, and report back.
              </p>
              <label className="flex items-center gap-1.5 mt-4 text-[10px] text-slate-500 cursor-pointer">
                <input
                  type="checkbox" checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-800 w-3 h-3"
                />
                Auto-approve plans
              </label>
            </div>
          )}

          {/* Message bubbles */}
          {messages.map(msg => (
            <div key={msg.id} className={`flex gap-2 ${msg.sender === 'user' ? 'justify-end' : ''}`}>
              {msg.sender === 'agent' && (
                <div className="w-6 h-6 rounded-full bg-purple-900/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Monitor className="w-3 h-3 text-purple-400" />
                </div>
              )}
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                msg.sender === 'user'
                  ? 'bg-purple-600/30 border border-purple-800/40'
                  : msg.sender === 'system'
                    ? 'bg-slate-800/30 border border-slate-700/30'
                    : msg.type === 'error'
                      ? 'bg-red-950/30 border border-red-800/30'
                      : msg.type === 'summary'
                        ? 'bg-emerald-950/30 border border-emerald-800/30'
                        : 'bg-slate-800/50'
              }`}>
                <p className={`text-[11px] leading-relaxed ${
                  msg.sender === 'user' ? 'text-purple-200' :
                  msg.sender === 'system' ? 'text-slate-400 italic' :
                  msg.type === 'error' ? 'text-red-300' :
                  msg.type === 'summary' ? 'text-emerald-300' :
                  'text-slate-300'
                }`}>
                  {msg.text}
                </p>
                <span className="text-[8px] text-slate-600 mt-0.5 block">{msg.time}</span>
              </div>
            </div>
          ))}

          {/* Inline approval card */}
          {session?.status === 'awaiting_approval' && !autoApprove && (
            <div className="bg-slate-800/40 border border-amber-800/30 rounded-2xl p-3 mx-2">
              <p className="text-[10px] text-amber-300 font-medium mb-2">Plan ready — {session.plan?.length || 0} steps</p>
              <div className="flex flex-col gap-1 mb-3 max-h-[120px] overflow-y-auto">
                {session.plan?.map(s => (
                  <div key={s.index} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                    <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                    <span className="truncate">{s.description}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={handleApprove} className="flex-1 py-1.5 rounded-lg bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center gap-1">
                  <Check className="w-3 h-3" /> Approve
                </button>
                <button onClick={handleCancel} className="px-3 py-1.5 rounded-lg border border-red-800 text-red-400 text-[10px]">
                  Reject
                </button>
              </div>
            </div>
          )}

          {/* Running indicator */}
          {session?.status === 'executing' && (
            <div className="flex items-center gap-2 px-2 py-1">
              <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
              <span className="text-[10px] text-blue-300">
                Step {(session.current_step || 0) + 1}/{session.plan?.length || '?'}...
              </span>
            </div>
          )}

          {/* Terminal state actions */}
          {isTerminal && (
            <div className="flex items-center gap-2 px-2">
              <button onClick={handleNewTask} className="text-[10px] text-slate-500 underline">
                New task
              </button>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Bottom input bar */}
      <div className="border-t border-slate-800 bg-[#0a0f1a] px-3 py-2 flex items-center gap-2 flex-shrink-0 safe-area-bottom">
        {/* Mic button — HTTP-based push-to-talk (no WebSocket needed) */}
        <button
          onClick={async () => {
            try {
              if (micRecorderRef.current) {
                // Stop recording — send audio for transcription
                micRecorderRef.current.stop();
                return;
              }

              // Get mic permission
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              setMicPermission('granted');
              addMsg('system', 'Recording... tap mic again to send');

              const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
              const chunks: Blob[] = [];
              recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
              recorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                micRecorderRef.current = null;

                if (chunks.length === 0) return;
                const blob = new Blob(chunks, { type: 'audio/webm' });

                // Convert to Float32 PCM for Parakeet
                try {
                  const arrayBuf = await blob.arrayBuffer();
                  const audioCtx = new AudioContext({ sampleRate: 16000 });
                  const decoded = await audioCtx.decodeAudioData(arrayBuf);
                  const pcm = decoded.getChannelData(0);
                  audioCtx.close();

                  // Chunked base64 encoding to avoid stack overflow on large buffers
                  const bytes = new Uint8Array(pcm.buffer);
                  let binary = '';
                  const chunkSize = 8192;
                  for (let i = 0; i < bytes.length; i += chunkSize) {
                    binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + chunkSize)));
                  }
                  const b64 = btoa(binary);

                  addMsg('system', 'Transcribing...');
                  const res = await fetch(`${relayUrl}/transcribe-audio`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ audio_data: b64, sample_rate: 16000, format: 'float32' }),
                  });
                  if (res.ok) {
                    const data = await res.json();
                    const text = data.text?.trim();
                    if (text) {
                      addMsg('user', `🎤 ${text}`);
                      if (session && !['completed', 'failed', 'cancelled'].includes(session.status)) {
                        // Active session — send as steering feedback
                        await fetch(`${relayUrl}/computer-use/feedback`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ session_id: session.session_id, message: text }),
                        }).catch(() => {});
                      } else if (isTerminal && session) {
                        // Completed/failed — use as follow-up
                        try {
                          const fRes = await fetch(`${relayUrl}/computer-use/follow-up`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ session_id: session.session_id, message: text }),
                          });
                          if (fRes.ok) {
                            addMsg('system', 'Session reopened with your feedback');
                            if (pollRef.current) clearInterval(pollRef.current);
                            pollRef.current = setInterval(() => pollSession(session.session_id), 2000);
                          }
                        } catch {}
                      } else {
                        // No session — create new CU task from voice
                        addMsg('system', 'Creating plan...');
                        try {
                          const cRes = await fetch(`${relayUrl}/screen-share/start`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ goal: text }),
                          });
                          const cData = await cRes.json();
                          if (cData.session_id) {
                            setSession({ session_id: cData.session_id, goal: text, status: 'planning', plan: [], current_step: 0 } as CuSession);
                            pollSession(cData.session_id);
                          }
                        } catch {}
                      }
                    } else {
                      addMsg('system', 'No speech detected');
                    }
                  } else {
                    addMsg('system', 'Transcription failed', 'error');
                  }
                } catch (e) {
                  addMsg('system', `Audio processing error: ${(e as Error).message}`, 'error');
                }
              };
              recorder.start();
              micRecorderRef.current = recorder;
            } catch (e) {
              addMsg('system', `Mic error: ${(e as Error).message || 'blocked'}`, 'error');
            }
          }}
          className={`p-2 rounded-full transition-colors flex-shrink-0 ${
            micRecorderRef.current ? 'bg-red-600 text-white animate-pulse' :
            micPermission === 'requesting' ? 'bg-purple-900 text-purple-400 animate-pulse' :
            'bg-slate-800 text-slate-400'
          }`}
        >
          {micRecorderRef.current ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
        </button>

        {/* Text input */}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={placeholder}
          className="flex-1 bg-slate-900/60 border border-slate-700 rounded-full px-4 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-purple-600"
          disabled={isCreating || session?.status === 'planning'}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!input.trim() || isCreating}
          className={`p-2 rounded-full flex-shrink-0 transition-colors ${
            input.trim()
              ? 'bg-purple-600 text-white'
              : 'bg-slate-800 text-slate-600'
          }`}
        >
          {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>

      {/* Recording indicator */}
      {micRecorderRef.current && (
        <div className="bg-red-950/40 border-t border-red-800/30 px-3 py-1.5 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          <span className="text-[9px] text-red-300">Recording... tap mic to send</span>
        </div>
      )}
    </div>
  );
}
