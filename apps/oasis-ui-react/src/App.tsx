import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, Bot, Settings, History, ArrowDown, Workflow, BookOpen, Monitor, Smartphone, FileStack, UserCog, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
import { assistantMessageId, cn, getErrorMessage, timelineClientKeyForMessage } from '@/lib/utils';

import type { Message, TimelineEvent, ProjectConfig, GraphData, RulesGraphData, CodeGraphData, ContextBudget } from '@/lib/types';
import { computeThoughtStreamRevision } from '@/lib/thoughtStreamRevision';
import { OASIS_BASE_URL, VOICE_AGENT_URL } from '@/lib/constants';
import { postInteraction } from '@/lib/interaction-api';
import { linkChatToProject } from '@/lib/artifact-api';
import { extractMentionedArtifactIds } from '@/lib/mention-utils';
import { useQuickUpload } from '@/hooks/useQuickUpload';

import { WaveformVisualizer, ListeningOrb, VoiceIdModal } from '@/components/voice';
import {
  ChatHeader,
  ChatMessage,
  ChatInputArea,
  TimelineOverlay,
  ThinkingOverlay,
  VoiceBubbles,
} from '@/components/chat';
import { VirtualizedChatMessages } from '@/components/chat/VirtualizedChatMessages';
import { ActiveMissionsBar, type MissionRow } from '@/components/chat/ActiveMissionsBar';
import { EmptyChatHints } from '@/components/chat/EmptyChatHints';
import type { SessionUsage as BudgetUsage, SessionBudget } from '@/components/chat/SessionBudgetPill';
import { GraphPanel } from '@/components/graph';
import { SettingsPanel, HistoryPanel, ArtifactsPanel, ProjectsPanel } from '@/components/panels';
import { AgentsPanel } from '@/components/agents/AgentsPanel';
import { RolePicker } from '@/components/chat/RolePicker';
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel';
import { SelfTeachingPanel } from '@/components/self-teaching/SelfTeachingPanel';
import { ComputerUsePanel } from '@/components/computer-use/ComputerUsePanel';
import { CaptureTargetPicker } from '@/components/computer-use/CaptureTargetPicker';
import type { CaptureTarget } from '@/components/computer-use/CaptureTargetPicker';
import { MobilePairingPanel } from '@/components/mobile/MobilePairingPanel';
import { useVoiceConnection } from '@/hooks/useVoiceConnection';
import { TokenUsageDonut } from '@/components/chat/TokenUsageDonut';

function isUserAbort(e: unknown): boolean {
  if (axios.isAxiosError(e) && e.code === 'ERR_CANCELED') return true;
  return typeof e === 'object' && e !== null && 'name' in e && (e as { name: string }).name === 'AbortError';
}

/** Persisted max autonomous hours — safe for JSON / session sync (never NaN). */
function readAutonomousMaxHours(): number {
  const n = parseInt(localStorage.getItem('oasis_autonomous_max_hours') || '6', 10);
  return Number.isFinite(n) && n >= 1 && n <= 24 ? n : 6;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [, setQueuedMessages] = useState<Array<{ clientMessageId: string; text: string; replyTo?: { messageId: string; preview: string } }>>([]);
  const queueRef = useRef<Array<{ clientMessageId: string; text: string; replyTo?: { messageId: string; preview: string } }>>([]);
  const [textSessionId, setTextSessionId] = useState(() => {
    const stored = sessionStorage.getItem('oasis-session-id');
    if (stored) return stored;
    const id = `browser-${crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('oasis-session-id', id);
    return id;
  });
  const [timelineByClientMessageId, setTimelineByClientMessageId] = useState<Record<string, TimelineEvent[]>>({});
  const [liveReasoningByClientId, setLiveReasoningByClientId] = useState<Record<string, string>>({});
  const [selectedTimelineMessageId, setSelectedTimelineMessageId] = useState<string | null>(null);
  const [activeClientMessageId, setActiveClientMessageId] = useState<string | null>(null);
  const [voiceIdModalOpen, setVoiceIdModalOpen] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [replyToMessageText, setReplyToMessageText] = useState<string>('');
  const [showGraphPanel, setShowGraphPanel] = useState(false);
  const [showSelfTeachingPanel, setShowSelfTeachingPanel] = useState(false);
  const [showComputerUsePanel, setShowComputerUsePanel] = useState(false);
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);
  const [showWorkflowsPanel, setShowWorkflowsPanel] = useState(false);
  const [showMobilePairingPanel, setShowMobilePairingPanel] = useState(false);
  const [showArtifactsPanel, setShowArtifactsPanel] = useState(false);
  const [showProjectsPanel, setShowProjectsPanel] = useState(false);
  // Missions visible inline in the chat — not in a separate panel. The map is the source of
  // truth; the SSE handlers below mutate it as Mission* events arrive.
  const [missionsById, setMissionsById] = useState<Record<string, MissionRow>>({});
  // Set of session_ids that are currently mid-interaction. Polled from
  // /api/v1/sessions/active every 5s; drives the green pulse on HistoryPanel
  // rows + the sidebar History-icon badge so cross-tab activity is visible.
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(() => new Set());
  // Per-session token / USD usage + budget cap. Polled alongside the active-session list.
  const [sessionUsage, setSessionUsage] = useState<BudgetUsage | null>(null);
  const [sessionBudget, setSessionBudget] = useState<SessionBudget | null>(null);
  const [sessionBudgetPct, setSessionBudgetPct] = useState<number>(0);
  // Active project role for routing chat → agent profile (model + preamble).
  // Persisted per project by <RolePicker> via localStorage.
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [graphsBySessionId, setGraphsBySessionId] = useState<Record<string, GraphData>>({});
  const [memoryRules, setMemoryRules] = useState<Array<{ rule_id?: string; condition?: string; conclusion?: string; confidence?: number }>>([]);
  const [rulesGraph, setRulesGraph] = useState<RulesGraphData | null>(null);
  const [rulesStorageBackend, setRulesStorageBackend] = useState<string | null>(null);
  const [codeGraph, setCodeGraph] = useState<CodeGraphData | null>(null);
  const [autonomousMode, setAutonomousMode] = useState(() => localStorage.getItem('oasis_autonomous_mode') === 'true');
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>({ configured: false });
  const [historySessions, setHistorySessions] = useState<Array<{ session_id: string; last_active: string; preview?: string }>>([]);

  const [cuScreenSharing, setCuScreenSharing] = useState(false);
  const [showCaptureTargetPicker, setShowCaptureTargetPicker] = useState(false);
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget | undefined>(undefined);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(() => localStorage.getItem('oasis_active_project') || undefined);
  const _setActiveProjectId = useCallback((id: string | undefined) => {
    setActiveProjectId(id);
    if (id) localStorage.setItem('oasis_active_project', id);
    else localStorage.removeItem('oasis_active_project');
    // Clear session-bound graphs/timelines from the old project so stale data doesn't persist
    setGraphsBySessionId({});
    setTimelineByClientMessageId({});
  }, []);
  const [contextBudget, setContextBudget] = useState<ContextBudget | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string | undefined>(undefined);

  // ── Infinite-scroll pagination state ──────────────────────────────────
  const [historyPage, setHistoryPage] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // ── Agent completion notifications ──
  const [notifications, setNotifications] = useState<string[]>([]);
  const originalTitleRef = useRef<string>('');
  const flashTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tracks which client_message_ids have received a ThinkingChunkGenerated
  // event.  When absent, the model doesn't expose separate reasoning tokens
  // and we show content text in the overlay instead of a blank "Working…".
  const seenThinkingRef = useRef<Set<string>>(new Set());

  /** Flash the document title between original and a badge so the user
   *  notices even if they're on another tab.  Auto-restores after 4s. */
  const flashTitle = useCallback((badge: string) => {
    if (!originalTitleRef.current) originalTitleRef.current = document.title;
    if (flashTimerRef.current) {
      clearInterval(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    let toggle = false;
    flashTimerRef.current = setInterval(() => {
      document.title = toggle ? `🔔 ${badge}` : originalTitleRef.current;
      toggle = !toggle;
    }, 1200);
    setTimeout(() => {
      if (flashTimerRef.current) {
        clearInterval(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      document.title = originalTitleRef.current;
    }, 4000);
  }, []);
  /** Stable ref so the SSE effect can call flashTitle without being in its dep array. */
  const flashTitleRef = useRef(flashTitle);
  flashTitleRef.current = flashTitle;

  // Fetch active project name whenever activeProjectId changes
  useEffect(() => {
    if (!activeProjectId) { setActiveProjectName(undefined); return; }
    axios.get(`${OASIS_BASE_URL}/api/v1/projects/${activeProjectId}`, { timeout: 5000 })
      .then(res => { setActiveProjectName(res.data?.name || undefined); })
      .catch(() => { setActiveProjectName(undefined); });
  }, [activeProjectId]);

  // Validate stored project ID on startup — sync with dev-agent's active project
  useEffect(() => {
    (async () => {
      try {
        // Ask dev-agent what project is active
        const devAgentRes = await axios.get(`${OASIS_BASE_URL}/api/v1/project/active`, { timeout: 5000 }).catch(() => null);
        const devAgentProjectId = devAgentRes?.data?.project_id;

        if (activeProjectId) {
          // Verify stored ID still exists in the gateway
          const projRes = await axios.get(`${OASIS_BASE_URL}/api/v1/projects/${activeProjectId}`, { timeout: 5000 }).catch(() => null);
          const exists = projRes?.data?.project_id === activeProjectId;

          if (!exists) {
            console.warn('[App] Stored project ID no longer exists, clearing');
            // If dev-agent has a valid project, use that instead
            if (devAgentProjectId) {
              const fallback = await axios.get(`${OASIS_BASE_URL}/api/v1/projects/${devAgentProjectId}`, { timeout: 5000 }).catch(() => null);
              if (fallback?.data?.project_id) {
                console.info('[App] Switching to dev-agent active project:', devAgentProjectId);
                _setActiveProjectId(devAgentProjectId);
                return;
              }
            }
            _setActiveProjectId(undefined);
          } else if (devAgentProjectId !== activeProjectId) {
            // The browser's persisted selection is authoritative for the
            // session; bring the dev-agent back into sync after a restart.
            await axios.post(`${OASIS_BASE_URL}/api/v1/project/activate`, { project_id: activeProjectId }, { timeout: 15000 }).catch(() => undefined);
          }
        } else if (devAgentProjectId) {
          // No stored project but dev-agent has one — auto-adopt it
          const projRes = await axios.get(`${OASIS_BASE_URL}/api/v1/projects/${devAgentProjectId}`, { timeout: 5000 }).catch(() => null);
          if (projRes?.data?.project_id) {
            console.info('[App] Auto-adopting dev-agent active project:', devAgentProjectId);
            _setActiveProjectId(devAgentProjectId);
          }
        }
      } catch {
        // Startup validation is best-effort
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-load messages on startup ──
  // When the user refreshes, restore the chat history so the session picks
  // up where they left off.  If the last interaction was in-flight we also
  // persist & restore the client message id so SSE backlog events
  // find the correct message rows instead of duplicating.
  useEffect(() => {
    const sid = sessionStorage.getItem('oasis-session-id');
    if (!sid) return;

    const storedClientId = sessionStorage.getItem('oasis-last-client-msg');

    loadHistoryPage(sid, 0, false, storedClientId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const quickUpload = useQuickUpload();

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isSendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  // Auto-request notification permission on mount so the browser prompt
  // fires from a user-gesture context (the first click / interaction).
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    const timer = setTimeout(() => { void Notification.requestPermission(); }, 2000);
    return () => clearTimeout(timer);
  }, []);

  /** Fire an OS-level notification — uses Electron IPC in desktop, Web Notification API in browser. */
  const fireOsNotification = useCallback((msg: string) => {
    try {
      // Electron desktop shell
      const w = window as unknown as { oasis?: { isDesktop?: boolean; notify?: (o: { title: string; body: string; silent?: boolean }) => void } };
      if (w.oasis?.isDesktop && w.oasis.notify) {
        w.oasis.notify({ title: 'Oasis', body: msg });
        return;
      }
      // Browser: use the Web Notification API
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Oasis', { body: msg });
      }
    } catch { /* notifications not supported */ }
  }, []);

  /** Push a notification, fire a toast, flash the document title, and send an OS notification.
   *  Used at every agent completion boundary so the user never misses
   *  a response even when looking at another tab. */
  const notifyAgentEvent = useCallback((msg: string, opts?: { variant?: 'default' | 'destructive' }) => {
    setNotifications(prev => [msg, ...prev].slice(0, 20));
    flashTitleRef.current(msg.length > 22 ? msg.slice(0, 20) + '…' : msg);
    toast({ title: msg, variant: opts?.variant || 'default' });
    // Fire OS notification on the next microtask so it doesn't block rendering
    queueMicrotask(() => fireOsNotification(msg));
  }, [toast, fireOsNotification]);
  /** Stable ref so the SSE effect can call notifyAgentEvent without being in its dep array. */
  const notifyRef = useRef(notifyAgentEvent);
  notifyRef.current = notifyAgentEvent;
  /** Tracks client_message_ids we've already notified for (SSE backlog replay suppression) */
  const notifiedIdsRef = useRef<Set<string>>(new Set());

  const dismissNotification = useCallback((idx: number) => {
    setNotifications(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const addMessage = useCallback((text: string, sender: Message['sender'], confidence?: string, isTranscript?: boolean, isQueued?: boolean, id?: string, replyTo?: { messageId: string; preview: string }) => {
    setMessages(prev => [...prev, {
      id: id || Math.random().toString(36).substring(7),
      text,
      sender,
      confidence,
      timestamp: new Date(),
      isTranscript,
      isQueued,
      replyToMessageId: replyTo?.messageId,
      replyToPreview: replyTo?.preview,
    }]);
  }, []);

  /** Assistant rows use {@link assistantMessageId} so streaming chunks never overwrite the user bubble. */
  const upsertAssistantMessage = useCallback((clientMessageId: string, text: string, confidence?: string) => {
    const aid = assistantMessageId(clientMessageId);
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === aid);
      if (idx >= 0) {
        return prev.map(m => (m.id === aid ? { ...m, text, confidence } : m));
      }
      return [...prev, {
        id: aid,
        text,
        sender: 'assistant' as const,
        confidence,
        timestamp: new Date(),
      }];
    });
  }, []);

  const loadGraphPanelData = useCallback(async () => {
    const normalizeRule = (r: Record<string, unknown>): { rule_id?: string; condition?: string; conclusion?: string; confidence?: number } => {
      const rule_id = r.rule_id != null ? String(r.rule_id) : r.id != null ? String(r.id) : undefined;
      const condition = String(r.condition ?? r.if ?? '').trim() || undefined;
      const conclusion = String(r.conclusion ?? r.assertion ?? r.then ?? '').trim() || undefined;
      let confidence: number | undefined;
      if (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) confidence = r.confidence;
      else if (r.confidence != null) {
        const c = parseFloat(String(r.confidence));
        if (Number.isFinite(c)) confidence = c;
      }
      return { rule_id, condition, conclusion, confidence };
    };

    try {
      const rulesRes = await axios.get(`${OASIS_BASE_URL}/api/v1/memory/rules`);
      const raw = rulesRes.data?.rules;
      const arr = Array.isArray(raw) ? raw : [];
      setMemoryRules(arr.map((x: Record<string, unknown>) => normalizeRule(x)));
      setRulesStorageBackend(typeof rulesRes.data?.storage === 'string' ? rulesRes.data.storage : null);
    } catch (e: unknown) {
      setMemoryRules([]);
      setRulesStorageBackend(null);
      const detail = axios.isAxiosError(e)
        ? (e.response?.data as { error?: string; detail?: string } | undefined)?.detail
          || (e.response?.data as { error?: string } | undefined)?.error
          || e.message
        : getErrorMessage(e);
      toast({ title: 'Could not load rules', description: String(detail), variant: 'destructive' });
    }

    try {
      const graphRes = await axios.get(`${OASIS_BASE_URL}/api/v1/memory/rules/graph`);
      const d = graphRes.data;
      if (d && Array.isArray(d.nodes) && Array.isArray(d.edges)) {
        setRulesGraph({ nodes: d.nodes, edges: d.edges });
      } else {
        setRulesGraph({ nodes: [], edges: [] });
      }
    } catch (e: unknown) {
      const detail = axios.isAxiosError(e)
        ? (e.response?.data as { error?: string; detail?: string } | undefined)?.detail
          || (e.response?.data as { error?: string } | undefined)?.error
          || e.message
        : getErrorMessage(e);
      toast({ title: 'Could not load rules graph', description: String(detail), variant: 'destructive' });
      setRulesGraph((prev) => prev ?? { nodes: [], edges: [] });
    }
  }, [toast]);

  const loadCodeGraph = useCallback(async () => {
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/code-graph/graph`);
      const d = res.data;
      if (d && Array.isArray(d.nodes) && Array.isArray(d.edges)) {
        setCodeGraph({ nodes: d.nodes, edges: d.edges, stats: d.stats });
      } else {
        setCodeGraph({ nodes: [], edges: [], stats: { files: 0, symbols: 0 } });
      }
    } catch {
      setCodeGraph(null);
    }
  }, []);

  const handleDeleteRule = useCallback(async (ruleId: string) => {
    try {
      await axios.delete(`${OASIS_BASE_URL}/api/v1/memory/rules`, { data: { rule_id: ruleId } });
      setMemoryRules(prev => prev.filter(r => r.rule_id !== ruleId));
      setRulesGraph(prev => prev ? { ...prev, nodes: prev.nodes.filter(n => n.id !== ruleId) } : null);
    } catch { /* silent */ }
  }, []);

  const loadHistorySessions = useCallback(async () => {
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/history/sessions`);
      setHistorySessions(res.data.sessions || []);
    } catch { /* silent */ }
  }, []);

  /**
   * Reload missions from the gateway. Cheap (single hash read in Redis) so we
   * call this on mount + after any mutation rather than maintaining a perfect
   * incremental view from SSE — events tell us *when* something changed; the
   * source of truth is always the canonical /api/v1/missions list.
   */
  const reloadMissions = useCallback(async () => {
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/missions`);
      const list: MissionRow[] = (res.data?.missions || []) as MissionRow[];
      const next: Record<string, MissionRow> = {};
      for (const m of list) next[m.mission_id] = m;
      setMissionsById(next);
    } catch { /* silent */ }
  }, []);

  // Initial load — populate the active-missions bar as soon as the app mounts.
  useEffect(() => { void reloadMissions(); }, [reloadMissions]);

  // Poll the cross-tab active-sessions list. 5s is fine — this drives the green
  // pulse on history rows + the sidebar History-icon badge; users won't notice
  // a 5s delay before another tab's activity shows up.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await axios.get(`${OASIS_BASE_URL}/api/v1/sessions/active`, { timeout: 4000 });
        if (cancelled) return;
        const ids: string[] = (res.data?.active || []).map((x: { session_id: string }) => x.session_id);
        setActiveSessionIds((prev) => {
          // Cheap equality check so we don't trigger re-renders on identical sets.
          if (prev.size === ids.length && ids.every((id) => prev.has(id))) return prev;
          return new Set(ids);
        });
      } catch { /* silent — endpoint optional */ }
    };
    void tick();
    const interval = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll the current session's usage + budget. Cheap (one Redis hash lookup
  // server-side); kept on a separate interval so changes to the cap don't
  // wait the full 5s of the active-sessions poll.
  const reloadBudget = useCallback(async (sid: string) => {
    if (!sid) return;
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/session/usage`, {
        params: { session_id: sid },
        timeout: 4000,
      });
      const d = res.data || {};
      setSessionUsage(d.usage || null);
      setSessionBudget(d.budget || null);
      setSessionBudgetPct(typeof d.pct === 'number' ? d.pct : 0);
    } catch {
      // endpoint optional — fail silent
    }
  }, []);

  useEffect(() => {
    if (!textSessionId) return;
    void reloadBudget(textSessionId);
    const interval = setInterval(() => reloadBudget(textSessionId), 6000);
    return () => clearInterval(interval);
  }, [textSessionId, reloadBudget]);

  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/history/messages`, { params: { session_id: sessionId, page: 0, limit: 50 } });
      const raw = res.data.messages || [];
      const hasMore = res.data.has_more === true;
      setHasMoreHistory(hasMore);
      let lastClientMsgId: string | undefined;
      const msgs: Message[] = raw.map((m: { role: string; content: string; timestamp: string; client_message_id?: string }, i: number) => {
        const cmId = m.client_message_id;
        const sender: Message['sender'] = m.role === 'user' ? 'user' : 'assistant';
        if (sender === 'user' && cmId) {
          lastClientMsgId = cmId;
          return { id: cmId, text: m.content, sender, timestamp: new Date(m.timestamp) };
        }
        if (sender === 'assistant' && lastClientMsgId) {
          return { id: assistantMessageId(lastClientMsgId), text: m.content, sender, timestamp: new Date(m.timestamp) };
        }
        return { id: `hist-${sessionId}-${i}`, text: m.content, sender, timestamp: new Date(m.timestamp) };
      });
      setMessages(msgs);
      setHistoryPage(0);
      setTextSessionId(sessionId);
      sessionStorage.setItem('oasis-session-id', sessionId);
      setTimelineByClientMessageId({});
      // Track in-flight API-started sessions so SSE events & thinking overlay work
      if (raw.length > 0) {
        const lastRaw = raw[raw.length - 1] as { role?: string; client_message_id?: string } | undefined;
        if (lastRaw?.role === 'user' && lastRaw?.client_message_id) {
          setActiveClientMessageId(lastRaw.client_message_id);
          setIsThinking(true);
        }
      }
      setShowHistoryPanel(false);
      // Reset scroll state so the "New messages" button doesn't persist across sessions
      setIsNearBottom(true);
      isNearBottomRef.current = true;
      userIntentionallyScrolledUp.current = false;
    } catch { /* silent */ }
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await axios.delete(`${OASIS_BASE_URL}/api/v1/history/session`, { params: { session_id: sessionId } });
      setHistorySessions(prev => prev.filter(s => s.session_id !== sessionId));
    } catch { /* silent */ }
  }, []);

  const sendToApi = useCallback(async (text: string, clientMessageId: string, replyTo?: { messageId: string; preview: string }, mentionedArtifactIds?: string[], attachedArtifactIds?: string[]) => {
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    setTimelineByClientMessageId(prev => ({
      ...prev,
      [clientMessageId]: [...(prev[clientMessageId] || []), { event_type: 'ClientRequestSent', timestamp: new Date().toISOString(), payload: { client_message_id: clientMessageId, user_message: text } }],
    }));
    // Per-request flags avoid a race with async POST /session/config after toggling Autonomous in Settings.
    const context: Record<string, unknown> = {
      source: 'ui',
      client_message_id: clientMessageId,
      autonomous_mode: autonomousMode,
      autonomous_max_duration_hours: readAutonomousMaxHours(),
    };
    if (replyTo) context.reply_to = { message_id: replyTo.messageId, preview: replyTo.preview };
    if (activeProjectId) context.project_id = activeProjectId;
    if (mentionedArtifactIds && mentionedArtifactIds.length > 0) context.mentioned_artifact_ids = mentionedArtifactIds;
    if (attachedArtifactIds && attachedArtifactIds.length > 0) context.attached_artifact_ids = attachedArtifactIds;

    return postInteraction(
      `${OASIS_BASE_URL}/api/v1/interaction`,
      {
        user_message: text,
        session_id: textSessionId,
        context,
        role_id: activeRoleId || undefined,
      },
      signal,
    );
  }, [textSessionId, autonomousMode, activeProjectId, activeRoleId]);

  const handleStopPipeline = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsThinking(false);
    isSendingRef.current = false;
    queueRef.current = [];
    setQueuedMessages([]);
    sessionStorage.removeItem('oasis-last-client-msg');
    addMessage('Pipeline stopped.', 'system');
  }, [addMessage]);

  const flushQueueIfIdle = useCallback(async () => {
    if (isSendingRef.current) return;
    const queue = queueRef.current;
    const next = queue[0];
    if (!next) return;
    queueRef.current = queue.slice(1);
    setQueuedMessages(queueRef.current);
    isSendingRef.current = true;
    setIsThinking(true);
    setActiveClientMessageId(next.clientMessageId);
    try {
      await sendToApi(next.text, next.clientMessageId, next.replyTo);
    } catch (e: unknown) {
      setIsThinking(false);
      if (isUserAbort(e)) return;
      const detail = axios.isAxiosError(e) ? (e.response?.data as { error?: string } | undefined)?.error || e.message : getErrorMessage(e);
      addMessage(`Error: ${detail}`, 'system');
      toast({ title: "Reasoning Pipeline Error", description: detail, variant: "destructive" });
    } finally {
      isSendingRef.current = false;
    }
  }, [addMessage, sendToApi, toast, textSessionId, upsertAssistantMessage]);

  const voice = useVoiceConnection({
    textSessionId,
    addMessage,
    upsertAssistantMessage,
    flushQueueIfIdle,
    setTimelineByClientMessageId,
    setActiveClientMessageId,
    setMessages,
    setIsThinking,
  });

  const [tick, setTick] = useState(0);
  useEffect(() => { if (!voice.micEnabled) return; const id = setInterval(() => setTick(t => t + 1), 80); return () => clearInterval(id); }, [voice.micEnabled]);

  // Suppress voice transcription while settings panel or voice-id modal is open
  useEffect(() => {
    voice.setSuppressTranscription(showSettingsPanel || voiceIdModalOpen);
  }, [showSettingsPanel, voiceIdModalOpen, voice.setSuppressTranscription]); // eslint-disable-line react-hooks/exhaustive-deps

  const timelineEventCount = Object.values(timelineByClientMessageId).reduce((acc, arr) => acc + arr.length, 0);
  /** Bumps on thought-layer chunk chars so main chat scroll follows streaming thoughts (overlay + layout height). */
  const activeThoughtStreamRevision = useMemo(() => {
    const live = activeClientMessageId ? timelineByClientMessageId[activeClientMessageId] || [] : [];
    return computeThoughtStreamRevision(live);
  }, [activeClientMessageId, timelineByClientMessageId]);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);

  // Track whether the user deliberately scrolled up (not just content growing)
  const userIntentionallyScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (!viewport) return;
    const handleScroll = () => {
      const distFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nearBottom = distFromBottom < 150;
      // Only mark as "user scrolled up" if scrollTop actually decreased (user dragged up),
      // not if content grew below the fold while we were at/near bottom
      if (viewport.scrollTop < lastScrollTop.current - 10 && !nearBottom) {
        userIntentionallyScrolledUp.current = true;
      }
      if (nearBottom) {
        userIntentionallyScrolledUp.current = false;
      }
      lastScrollTop.current = viewport.scrollTop;
      isNearBottomRef.current = nearBottom;
      setIsNearBottom(nearBottom);
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (userIntentionallyScrolledUp.current) return;
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop.current = viewport.scrollTop;
    }
  }, [messages, isThinking, voice.isTranscribing, voice.liveTranscript, timelineEventCount, activeThoughtStreamRevision]);

  // ResizeObserver: auto-scroll when content height grows (e.g. streaming tool-use cards expanding)
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (!viewport) return;
    const content = viewport.firstElementChild as HTMLElement | null;
    if (!content) return;
    let prevHeight = content.scrollHeight;
    const ro = new ResizeObserver(() => {
      const newHeight = content.scrollHeight;
      if (newHeight > prevHeight && !userIntentionallyScrolledUp.current) {
        viewport.scrollTop = viewport.scrollHeight;
        lastScrollTop.current = viewport.scrollTop;
      }
      prevHeight = newHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (viewport) {
      userIntentionallyScrolledUp.current = false;
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
      lastScrollTop.current = viewport.scrollHeight;
    }
  }, []);

  // ── Infinite-scroll history pagination ──────────────────────────────────
  const loadingHistoryRef = useRef(false);
  const loadHistoryPage = useCallback(async (sid: string, page: number, append: boolean, storedClientId?: string | null) => {
    if (loadingHistoryRef.current) return;
    loadingHistoryRef.current = true;
    setLoadingHistory(true);
    try {
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/history/messages`, {
        params: { session_id: sid, page, limit: 50 },
        timeout: 8000,
      });
      const raw = res.data.messages || [];
      const hasMore = res.data.has_more === true;
      setHasMoreHistory(hasMore);

      if (page === 0 && !append) {
        // Initial load: assign IDs from stored client_message_id when available,
        // so SSE events can correlate properly (critical for API-started sessions).
        let lastClientMsgId: string | undefined;
        const msgs: Message[] = raw.map((m: { role: string; content: string; timestamp: string; client_message_id?: string }, i: number) => {
          const cmId = m.client_message_id;
          const sender = m.role === 'user' ? 'user' as const : 'assistant' as const;
          if (sender === 'user' && cmId) {
            lastClientMsgId = cmId;
            return { id: cmId, text: m.content, sender, timestamp: new Date(m.timestamp) };
          }
          // For assistant messages right after a user message with known client_message_id,
          // derive the SSE-compatible ID so ResponseChunkGenerated events can find them.
          if (sender === 'assistant' && lastClientMsgId) {
            return { id: assistantMessageId(lastClientMsgId), text: m.content, sender, timestamp: new Date(m.timestamp) };
          }
          return { id: '', text: m.content, sender, timestamp: new Date(m.timestamp) };
        });

        // If the last interaction was in-flight, reconstruct rows with SSE-compatible IDs
        if (storedClientId && msgs.length >= 1) {
          const last = msgs[msgs.length - 1];
          if (last.sender === 'user') {
            msgs[msgs.length - 1] = { ...last, id: storedClientId };
          } else {
            if (msgs.length >= 2 && msgs[msgs.length - 2]?.sender === 'user') {
              msgs[msgs.length - 2] = { ...msgs[msgs.length - 2], id: storedClientId };
              msgs[msgs.length - 1] = { ...last, id: assistantMessageId(storedClientId) };
            }
            sessionStorage.removeItem('oasis-last-client-msg');
          }
        }

        // For the last in-flight user message, track it for SSE correlation.
        // Use storedClientId from sessionStorage when the UI sent the message,
        // or fall back to the stored client_message_id for API-started sessions.
        const lastRaw = raw.length > 0 ? raw[raw.length - 1] as { role?: string; client_message_id?: string } : undefined;
        if (lastRaw?.role === 'user') {
          if (storedClientId) {
            setActiveClientMessageId(storedClientId);
          } else if (lastRaw?.client_message_id) {
            setActiveClientMessageId(lastRaw.client_message_id);
          }
        }
        if (lastRaw?.role === 'user') setIsThinking(true);

        // Fill in synthetic IDs for any messages that still lack them
        setMessages(msgs.map((m, i) => (m.id ? m : { ...m, id: `hist-${sid}-${i}` })));
      } else {
        // Append older messages at the beginning (prepend)
        const olderMsgs: Message[] = raw.map((m: { role: string; content: string; timestamp: string }, i: number) => ({
          id: `hist-${sid}-p${page}-${i}`,
          text: m.content,
          sender: m.role === 'user' ? 'user' : 'assistant',
          timestamp: new Date(m.timestamp),
        }));
        setMessages(prev => [...olderMsgs, ...prev]);
      }
      setHistoryPage(page);
    } catch {
      // No more history or error
      setHasMoreHistory(false);
    } finally {
      loadingHistoryRef.current = false;
      setLoadingHistory(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync autonomous mode to backend whenever session changes (including new chats)
  useEffect(() => {
    if (!textSessionId) return;
    axios.post(`${OASIS_BASE_URL}/api/v1/session/config`, {
      session_id: textSessionId,
      autonomous_mode: autonomousMode,
      autonomous_max_duration_hours: parseInt(localStorage.getItem('oasis_autonomous_max_hours') || '6', 10),
    }).catch(() => {});
  }, [textSessionId, autonomousMode]);

  // Auto-link every new session to the active project (covers initial load & project switches)
  useEffect(() => {
    if (activeProjectId && textSessionId) {
      linkChatToProject(activeProjectId, textSessionId).catch(() => { /* best effort */ });
    }
  }, [activeProjectId, textSessionId]);

  const handleAutonomousModeChange = useCallback((enabled: boolean) => {
    setAutonomousMode(enabled);
    localStorage.setItem('oasis_autonomous_mode', String(enabled));
  }, []);

  useEffect(() => {
    axios.get(`${OASIS_BASE_URL}/api/v1/project/config`, { timeout: 5000 })
      .then(res => { const d = res.data; if (d?.success && d.config) setProjectConfig({ configured: true, project_path: d.config.project_path, project_name: d.config.project_name, project_type: d.config.project_type, git_url: d.config.git_url, last_indexed: d.config.last_indexed, context_summary: d.config.context_summary, tech_stack: d.config.tech_stack, frameworks: d.config.frameworks }); })
      .catch(() => { /* dev-agent not running */ });
  }, [activeProjectId]);

  // ── CU session progress poller (lives at App level so it survives panel close) ──
  const cuPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cuSessionIdRef = useRef<string | null>(null);
  const cuReportedStepsRef = useRef<number>(0);
  const cuSummarySentRef = useRef<Set<string>>(new Set());
  const cuSummaryWaitRef = useRef<number>(0);

  const startCuPoller = useCallback((sessionId: string) => {
    if (cuPollRef.current) clearInterval(cuPollRef.current);
    cuSessionIdRef.current = sessionId;
    cuReportedStepsRef.current = 0;
    cuSummaryWaitRef.current = 0;

    // Launch the always-on-top overlay window via dev-agent
    const devAgentUrl = `${window.location.protocol}//${window.location.hostname}:8008`;
    axios.post(`${devAgentUrl}/internal/dev-agent/cu-overlay/launch`, {
      session_id: sessionId,
      gateway_port: new URL(OASIS_BASE_URL).port || '8000',
    }).catch(() => { /* overlay not available — not critical */ });

    cuPollRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`${OASIS_BASE_URL}/api/v1/computer-use/sessions/${sessionId}`, { timeout: 5000 });
        const session = res.data;
        const plan = session.plan || [];

        // Report newly completed/failed steps to chat
        const completedSteps = plan.filter((s: any) => s.status === 'completed' || s.status === 'failed');
        if (completedSteps.length > cuReportedStepsRef.current) {
          for (let i = cuReportedStepsRef.current; i < completedSteps.length; i++) {
            const step = completedSteps[i];
            const icon = step.status === 'completed' ? '✓' : '✗';
            const brief = step.output ? ` — ${(step.output as string).split('\n')[0].slice(0, 100)}` : '';
            addMessage(
              `${icon} Step ${step.index + 1}: ${step.description}${brief}`,
              'system',
            );
          }
          cuReportedStepsRef.current = completedSteps.length;
        }

        // Session terminal — wait for summary then stop polling.
        // Summary is generated async on the backend, so it may not be ready
        // when we first see status=completed. Keep polling up to ~15s for it.
        if (['completed', 'failed', 'cancelled'].includes(session.status)) {
          if (cuSummarySentRef.current.has(sessionId)) {
            // Already sent — stop
            if (cuPollRef.current) { clearInterval(cuPollRef.current); cuPollRef.current = null; }
          } else {
            const summary = session.summary as string | undefined;
            if (summary) {
              if (cuPollRef.current) { clearInterval(cuPollRef.current); cuPollRef.current = null; }
              cuSummarySentRef.current.add(sessionId);
              addMessage(summary, 'assistant');
            } else {
              // No summary yet — bump wait counter (stored on ref to persist across polls)
              cuSummaryWaitRef.current = (cuSummaryWaitRef.current || 0) + 1;
              if (cuSummaryWaitRef.current > 5) {
                if (cuPollRef.current) { clearInterval(cuPollRef.current); cuPollRef.current = null; }
                cuSummarySentRef.current.add(sessionId);
                addMessage(
                  session.status === 'failed'
                    ? `Computer-use task failed: ${session.error || 'unknown error'}`
                    : 'Computer-use task completed.',
                  'system',
                );
              }
            }
          }
        }
      } catch { /* ignore */ }
    }, 3000);
  }, [addMessage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (cuPollRef.current) clearInterval(cuPollRef.current); };
  }, []);

  useEffect(() => {
    const es = new EventSource(`${OASIS_BASE_URL}/api/v1/events/timeline?session_id=${encodeURIComponent(textSessionId)}&backlog=100`);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as TimelineEvent;

        // ── Mission lifecycle events (created / updated / deleted / paused / resumed):
        //    refresh the active-missions bar from the canonical list. Optimistic
        //    state nudges (running ↔ idle) avoid the flash where the run completes
        //    before our reload returns.
        if (data.event_type === 'MissionCreated' || data.event_type === 'MissionUpdated' || data.event_type === 'MissionDeleted') {
          void reloadMissions();
          return;
        }

        // Snap the budget pill into sync as soon as a turn completes or the cap
        // is hit, instead of waiting for the next 6s poll.
        if (data.event_type === 'ResponseGenerated' || data.event_type === 'SessionBudgetExceeded') {
          if (data.session_id === textSessionId || (data.payload as Record<string, unknown>)?.session_id === textSessionId) {
            void reloadBudget(textSessionId);
          }
        }

        // Terminal events clear the thinking state — important when the
        // pipeline finished while the page was refreshing (SSE backlog replay).
        if (
          data.event_type === 'ResponseGenerated' ||
          data.event_type === 'ResponseFailed' ||
          data.event_type === 'InteractionFailed' ||
          data.event_type === 'InteractionAborted'
        ) {
          setIsThinking(false);
          sessionStorage.removeItem('oasis-last-client-msg');
          // Clear reasoning overlay + tracking ref once the response is done
          const clientMsgId = (data.payload as any)?.client_message_id;
          if (clientMsgId) {
            seenThinkingRef.current.delete(clientMsgId);
            setLiveReasoningByClientId(prev => {
              if (prev[clientMsgId]) { const n = { ...prev }; delete n[clientMsgId]; return n; }
              return prev;
            });
          }
          // Notify the user when a chat response completes (or fails).
          // Suppress backlog replay duplicates by tracking notified client_message_ids.
          if (data.event_type === 'ResponseGenerated' && clientMsgId && !notifiedIdsRef.current.has(clientMsgId)) {
            notifiedIdsRef.current.add(clientMsgId);
            notifyRef.current('Agent finished responding.');
          } else if (data.event_type === 'ResponseFailed') {
            notifyRef.current('Agent response failed.', { variant: 'destructive' });
          }
        }
        if (data.event_type === 'MissionRunStarted') {
          const p = data.payload as Record<string, any>;
          const mid = p?.mission_id;
          if (!mid) return;
          // Optimistic state nudge so the active-missions bar pulses immediately.
          setMissionsById((prev) => prev[mid] ? ({ ...prev, [mid]: { ...prev[mid], state: 'running' } }) : prev);
          // Append a "running…" digest card so the user sees the work happening,
          // not just a silent gap before the result lands. Use a per-mission row id
          // so the completion handler can replace it in place.
          const runningRowId = `mission-running-${mid}`;
          setMessages((prev) => {
            if (prev.some((m) => m.id === runningRowId)) return prev;
            return [...prev, {
              id: runningRowId,
              text: '',
              sender: 'mission',
              timestamp: new Date(p.started_at || data.timestamp || Date.now()),
              missionDigest: {
                mission_id: mid,
                goal: p.goal || '',
                run_count: 0, // unknown until completion
                finished_at: p.started_at || data.timestamp || new Date().toISOString(),
                started_at: p.started_at,
                triggered_by: p.triggered_by,
                running: true,
              },
            }];
          });
          return;
        }

        // ── Mission digests don't have client_message_id; surface them as their
        //    own chat row (sender='mission') so they render inline next to the
        //    conversation that asked for the mission. Also fire a native
        //    notification when running in the Electron desktop shell so the
        //    user sees results without having Oasis in the foreground.
        if (data.event_type === 'MissionRunCompleted') {
          const p = data.payload as Record<string, any>;
          if (!p?.mission_id) return;
          const rowId = `mission-${p.mission_id}-${p.run_count ?? Date.now()}`;
          const runningRowId = `mission-running-${p.mission_id}`;
          const finalDigest: Message['missionDigest'] = {
            mission_id: p.mission_id,
            goal: p.goal || '',
            result: p.result,
            error: p.error,
            run_count: p.run_count ?? 0,
            finished_at: p.finished_at || data.timestamp || new Date().toISOString(),
            started_at: p.started_at,
            triggered_by: p.triggered_by,
          };
          setMessages((prev) => {
            // If a "running…" row is already in place for this mission, replace it
            // (preserves the in-place feel — the same card transitions from running → done).
            const runIdx = prev.findIndex((m) => m.id === runningRowId);
            if (runIdx >= 0) {
              const next = [...prev];
              next[runIdx] = {
                ...prev[runIdx],
                id: rowId,
                timestamp: new Date(finalDigest.finished_at),
                missionDigest: finalDigest,
              };
              return next;
            }
            // Manual run with no preceding RunStarted, or backlog replay — just append.
            if (prev.some((m) => m.id === rowId)) return prev;
            return [...prev, {
              id: rowId,
              text: '',
              sender: 'mission',
              timestamp: new Date(finalDigest.finished_at),
              missionDigest: finalDigest,
            }];
          });
          // Refresh the active-missions bar so state/last_run/next_run reflect this completion.
          void reloadMissions();
          // Native notification (no-op in the browser; Electron preload exposes window.oasis.notify).
          const w = window as unknown as { oasis?: { isDesktop?: boolean; notify?: (o: { title: string; body: string; silent?: boolean }) => void } };
          if (w.oasis?.isDesktop && w.oasis.notify) {
            const title = p.error ? `Mission failed: ${p.goal || 'untitled'}` : `Mission digest: ${p.goal || 'untitled'}`;
            const bodyText = p.error
              ? String(p.error).slice(0, 200)
              : (p.result ? String(p.result).replace(/\s+/g, ' ').slice(0, 200) : 'Run completed.');
            try { w.oasis.notify({ title, body: bodyText }); } catch { /* notifications not supported */ }
          }
          // Toast + title flash so the user notices even in the browser.
          if (p.error) {
            notifyRef.current(`Mission failed: ${(p.goal || 'untitled').slice(0, 60)}`, { variant: 'destructive' });
          } else {
            notifyRef.current(`Mission completed: ${(p.goal || 'untitled').slice(0, 60)}`);
          }
          return;
        }

        // ── Coordinator (parallel subagent) events ──────────────────────
        // These surface as their own chat rows (sender='coordinator') for
        // preflight approval cards and child report digests.
        if (data.event_type === 'CoordinatorPreflightReady') {
          const p = data.payload as Record<string, any>;
          if (!p?.job_id) return;
          const rowId = `job-${p.job_id}`;
          const cardPayload = {
            job_id: p.job_id,
            status: 'awaiting_approval' as const,
            task_count: p.task_count ?? 0,
            parallel_allowed: p.parallel_allowed ?? 1,
            degraded_mode: (p.degraded_mode ?? 'full') as 'full' | 'sequential' | 'reduced',
            degraded_reason: p.degraded_reason,
            est_usd_low: p.est_usd_low ?? 0,
            est_usd_high: p.est_usd_high ?? 0,
            host_ram_mb: p.host_ram_mb ?? 0,
            child_reports: [],
          };
          setMessages(prev => prev.some(m => m.id === rowId) ? prev : [...prev, {
            id: rowId,
            text: '',
            sender: 'coordinator',
            timestamp: new Date(),
            jobApproval: cardPayload,
          }]);
          return;
        }

        if (data.event_type === 'SubagentStarted' || data.event_type === 'SubagentReport' || data.event_type === 'JobCompleted') {
          const p = data.payload as Record<string, any>;
          const jobId = p?.job_id;
          if (!jobId) return;
          const rowId = `job-${jobId}`;
          setMessages(prev => prev.map(m => {
            if (m.id !== rowId || !m.jobApproval) return m;
            const j = { ...m.jobApproval };
            if (data.event_type === 'SubagentStarted') {
              j.status = 'running';
            } else if (data.event_type === 'SubagentReport') {
              j.child_reports = [...(j.child_reports || []), {
                task_id: p.task_id,
                status: p.status,
                cost_usd: p.cost_usd,
                final_message: p.final_message,
              }];
            } else if (data.event_type === 'JobCompleted') {
              j.status = p.status === 'completed' ? 'completed' : p.status === 'failed' ? 'failed' : 'cancelled';
              if (p.error) j.error = p.error;
              // Notify for completed coordinator jobs
              if (p.status === 'completed') {
                notifyRef.current('Coordinator job completed.');
              } else if (p.status === 'failed') {
                notifyRef.current('Coordinator job failed.', { variant: 'destructive' });
              }
            }
            return { ...m, jobApproval: j };
          }));
          return;
        }

        const clientId = data?.payload?.client_message_id;
        if (typeof clientId !== 'string' || !clientId) return;

        // Special handling for streaming updates to existing state
        if (data.event_type === 'ResponseChunkGenerated') {
          const fullText = (data.payload as any).full_text;
          const assistantRowId = assistantMessageId(clientId);
          // Do NOT push response chunks into the thinking overlay — that's
          // for reasoning tokens (ThinkingChunkGenerated) only.  The chat
          // message itself already streams the response text, so putting it
          // in the overlay too just duplicates content, especially for
          // casual/complex routes that never produce reasoning tokens.
          setMessages(prev => {
            const aidx = prev.findIndex(m => m.id === assistantRowId);
            if (aidx >= 0) {
              return prev.map(m => (m.id === assistantRowId ? { ...m, text: fullText } : m));
            }
            // Backlog replay: check if an assistant message with this text (or containing this chunk)
            // already exists (loaded from history with a hist-* ID). If so, don't duplicate.
            if (fullText && prev.some(m => m.sender === 'assistant' && m.text.includes(fullText))) {
              return prev;
            }
            const uidx = prev.findIndex(m => m.id === clientId && m.sender === 'user');
            if (uidx >= 0) {
              const next = [...prev];
              next.splice(uidx + 1, 0, {
                id: assistantRowId,
                text: fullText,
                sender: 'assistant',
                timestamp: new Date(),
              });
              return next;
            }
            return [...prev, {
              id: assistantRowId,
              text: fullText,
              sender: 'assistant',
              timestamp: new Date(),
            }];
          });
          return; // Don't add chunk events to timeline for performance
        }

        if (data.event_type === 'ToolReasoningChunkGenerated') {
          const fullReasoning = (data.payload as any).full_reasoning || '';
          const iteration = (data.payload as any).iteration;
          // Update timeline event for this iteration
          setTimelineByClientMessageId(prev => {
            const events = prev[clientId] || [];
            const updatedEvents = events.map(e => {
              if (e.event_type === 'ToolCallStarted' && (e.payload as any).iteration === iteration) {
                return { ...e, payload: { ...e.payload, reasoning: fullReasoning } };
              }
              return e;
            });
            return { ...prev, [clientId]: updatedEvents };
          });
          // Update live reasoning overlay so thinking card shows tool-loop reasoning
          seenThinkingRef.current.add(clientId);
          setLiveReasoningByClientId(prev => ({ ...prev, [clientId]: fullReasoning }));
          return;
        }

        // Live reasoning from thinking models (Gemma, DeepSeek R1, etc.)
        if (data.event_type === 'ThinkingChunkGenerated') {
          const fullReasoning = (data.payload as any).full_reasoning || '';
          seenThinkingRef.current.add(clientId);
          setLiveReasoningByClientId(prev => ({ ...prev, [clientId]: fullReasoning }));
          return;
        }

        // Context budget update for token usage donut
        if (data.event_type === 'ContextBudgetUpdated') {
          setContextBudget(data.payload as unknown as ContextBudget);
          return;
        }

        setTimelineByClientMessageId(prev => ({ ...prev, [clientId]: [...(prev[clientId] || []), data] }));
        // Live graph update: TaskGraphUpdated event updates the session's graph
        // Merge with existing to preserve conclusion/reasoning_trace/confidence when payload doesn't provide them
        if (data?.event_type === 'TaskGraphUpdated' && data?.payload?.session_id && data?.payload?.task_graph) {
          const sid = data.payload.session_id as string;
          const tg = data.payload.task_graph as Record<string, unknown>;
          const payloadConclusion = data.payload.conclusion as string | undefined;
          const payloadConfidence = data.payload.confidence as number | undefined;
          const payloadTrace = data.payload.reasoning_trace as string[] | undefined;
          setGraphsBySessionId(prev => {
            const existing = prev[sid];
            return {
              ...prev,
              [sid]: {
                graph: tg,
                timestamp: new Date().toISOString(),
                reasoning_trace: payloadTrace ?? existing?.reasoning_trace,
                confidence: payloadConfidence ?? existing?.confidence,
                conclusion: payloadConclusion ?? existing?.conclusion,
              },
            };
          });
        }
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [textSessionId]);

  useEffect(() => { if (!isThinking && queueRef.current.length > 0) void flushQueueIfIdle(); }, [isThinking, flushQueueIfIdle]);

  const hasAutoConnectedRef = useRef(false);
  useEffect(() => { if (hasAutoConnectedRef.current) return; hasAutoConnectedRef.current = true; void voice.handleConnect(); }, [voice.handleConnect]);

  const sendText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const clientMessageId = Math.random().toString(36).substring(7);
    const replyTo = replyToMessageId && replyToMessageText
      ? { messageId: replyToMessageId, preview: replyToMessageText.length > 150 ? replyToMessageText.slice(0, 150) + '…' : replyToMessageText }
      : undefined;
    if (replyTo) {
      setReplyToMessageId(null);
      setReplyToMessageText('');
    }

    // Extract artifact context before sending
    const mentionedIds = extractMentionedArtifactIds(trimmed);
    const attachedIds = quickUpload.getReadyArtifactIds();

    if (isThinking || isSendingRef.current) {
      queueRef.current = [...queueRef.current, { clientMessageId, text: trimmed, replyTo }];
      setQueuedMessages(queueRef.current);
      addMessage(trimmed, 'user', undefined, false, true, clientMessageId, replyTo ? { messageId: replyTo.messageId, preview: replyTo.preview } : undefined);
      quickUpload.clearAll();
      return;
    }
    setActiveClientMessageId(clientMessageId);
    sessionStorage.setItem('oasis-last-client-msg', clientMessageId);
    addMessage(trimmed, 'user', undefined, false, false, clientMessageId, replyTo ? { messageId: replyTo.messageId, preview: replyTo.preview } : undefined);
    quickUpload.clearAll();
    isSendingRef.current = true;
    setIsThinking(true);
    try {
      await sendToApi(trimmed, clientMessageId, replyTo, mentionedIds, attachedIds);
    } catch (e: unknown) {
      setIsThinking(false);
      if (isUserAbort(e)) return;
      const detail = axios.isAxiosError(e) ? (e.response?.data as { error?: string } | undefined)?.error || e.message : getErrorMessage(e);
      addMessage(`Error: ${detail}`, 'system');
      toast({ title: "Reasoning Pipeline Error", description: detail, variant: "destructive" });
    } finally {
      isSendingRef.current = false;
    }
  }, [replyToMessageId, replyToMessageText, isThinking, addMessage, sendToApi, flushQueueIfIdle, toast, upsertAssistantMessage, textSessionId, quickUpload]);

  const sendMessage = useCallback(async () => {
    if (!inputText.trim()) return;
    const text = inputText.trim();
    setInputText('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    await sendText(text);
  }, [inputText, sendText]);

  const handleVoiceIdClick = useCallback(() => {
    if (!voice.isConnected) { toast({ title: "Voice Not Connected", description: "Connect to the voice session before setting up Voice ID.", variant: "destructive" }); return; }
    setVoiceIdModalOpen(true);
  }, [voice.isConnected, toast]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    const newId = `browser-${crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    setTextSessionId(newId);
    sessionStorage.setItem('oasis-session-id', newId);
    sessionStorage.removeItem('oasis-last-client-msg');
    setTimelineByClientMessageId({});
    setGraphsBySessionId({});
    setShowHistoryPanel(false);
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    userIntentionallyScrolledUp.current = false;
    // Auto-link new session to active project
    if (activeProjectId) {
      linkChatToProject(activeProjectId, newId).catch(() => { /* best effort */ });
    }
  }, [activeProjectId]);

  const handleOptionClick = useCallback((option: string) => {
    setInputText('');
    const clientMessageId = Math.random().toString(36).substring(7);
    setActiveClientMessageId(clientMessageId);
    addMessage(option, 'user', undefined, false, false, clientMessageId);
    isSendingRef.current = true;
    setIsThinking(true);
    sendToApi(option, clientMessageId).then(() => {
    }).catch((e: unknown) => {
      setIsThinking(false);
      if (isUserAbort(e)) return;
      const detail = axios.isAxiosError(e) ? (e.response?.data as { error?: string } | undefined)?.error || e.message : getErrorMessage(e);
      addMessage(`Error: ${detail}`, 'system');
    }).finally(() => { isSendingRef.current = false; });
  }, [addMessage, sendToApi, flushQueueIfIdle, textSessionId, upsertAssistantMessage]);

  return (
    <div className="flex h-screen w-full bg-[#030712] text-slate-100 overflow-hidden">
      {showSidebar && <div className="md:hidden fixed inset-0 bg-black/60 z-20" onClick={() => setShowSidebar(false)} aria-hidden="true" />}
      <div className={cn("w-16 min-w-[64px] flex-shrink-0 flex flex-col items-center py-6 border-r border-slate-800 bg-[#0a0f1a] gap-8 z-30", !showSidebar && "max-md:hidden", showSidebar && "max-md:fixed max-md:left-0 max-md:top-0 max-md:h-screen max-md:shadow-xl")}>
        <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shadow-lg shadow-blue-900/10">
          <img src="/favicon.svg" alt="Oasis" className="w-7 h-7 select-none" draggable={false} />
        </div>
        <div className="flex-1 flex flex-col gap-6">
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white relative", showHistoryPanel && "text-blue-400")}
            onClick={() => {
              setShowHistoryPanel(v => !v);
              if (!showHistoryPanel) {
                loadHistorySessions();
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowSelfTeachingPanel(false);
                setShowComputerUsePanel(false);
                setShowAgentsPanel(false);
                setShowWorkflowsPanel(false);
                setShowMobilePairingPanel(false);
                setShowArtifactsPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title={
              activeSessionIds.size > (activeSessionIds.has(textSessionId) ? 1 : 0)
                ? `Chat history — ${activeSessionIds.size - (activeSessionIds.has(textSessionId) ? 1 : 0)} other session(s) working`
                : 'Chat history'
            }
          >
            <History className="w-5 h-5" />
            {activeSessionIds.size > (activeSessionIds.has(textSessionId) ? 1 : 0) && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-[#0a0f1a] animate-pulse" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showGraphPanel && "text-blue-400")}
            onClick={() => {
              setShowGraphPanel(v => !v);
              if (!showGraphPanel) {
                loadGraphPanelData();
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowSelfTeachingPanel(false);
                setShowComputerUsePanel(false);
                setShowAgentsPanel(false);
                setShowWorkflowsPanel(false);
                setShowMobilePairingPanel(false);
                setShowArtifactsPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title="Knowledge graph & Logic engine"
          >
            <Workflow className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showSelfTeachingPanel && "text-blue-400")}
            onClick={() => {
              setShowSelfTeachingPanel(v => !v);
              if (!showSelfTeachingPanel) {
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowComputerUsePanel(false);
                setShowAgentsPanel(false);
                setShowWorkflowsPanel(false);
                setShowMobilePairingPanel(false);
                setShowArtifactsPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title="Self Teaching"
          >
            <BookOpen className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showComputerUsePanel && "text-purple-400")}
            onClick={() => {
              setShowComputerUsePanel(v => !v);
              if (!showComputerUsePanel) {
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowSelfTeachingPanel(false);
                setShowAgentsPanel(false);
                setShowWorkflowsPanel(false);
                setShowMobilePairingPanel(false);
                setShowArtifactsPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title="Computer Use"
          >
            <Monitor className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showAgentsPanel && "text-emerald-400")}
            onClick={() => {
              setShowAgentsPanel(v => !v);
              if (!showAgentsPanel) {
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowSelfTeachingPanel(false);
                setShowComputerUsePanel(false);
                setShowWorkflowsPanel(false);
                setShowMobilePairingPanel(false);
                setShowArtifactsPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title="Agents"
          >
            <UserCog className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showWorkflowsPanel && "text-violet-400")}
            onClick={() => {
              setShowWorkflowsPanel(v => !v);
              if (!showWorkflowsPanel) {
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowSelfTeachingPanel(false);
                setShowComputerUsePanel(false);
                setShowAgentsPanel(false);
                setShowMobilePairingPanel(false);
                setShowArtifactsPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title="Workflows"
          >
            <Workflow className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showMobilePairingPanel && "text-cyan-400")}
            onClick={() => {
              setShowMobilePairingPanel(v => !v);
              if (!showMobilePairingPanel) {
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowSelfTeachingPanel(false);
                setShowComputerUsePanel(false);
                setShowAgentsPanel(false);
                setShowWorkflowsPanel(false);
                setShowArtifactsPanel(false);
              }
            }}
            title="Mobile Companion"
          >
            <Smartphone className="w-5 h-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-slate-400 hover:text-white", showArtifactsPanel && "text-amber-400")}
            onClick={() => {
              setShowArtifactsPanel(v => !v);
              if (!showArtifactsPanel) {
                setShowHistoryPanel(false);
                setShowSettingsPanel(false);
                setShowGraphPanel(false);
                setShowSelfTeachingPanel(false);
                setShowComputerUsePanel(false);
                setShowAgentsPanel(false);
                setShowWorkflowsPanel(false);
                setShowMobilePairingPanel(false);
                setShowProjectsPanel(false);
              }
            }}
            title="Artifacts"
          >
            <FileStack className="w-5 h-5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={cn("text-slate-400 hover:text-white", showSettingsPanel && "text-blue-400")}
          onClick={() => {
            setShowSettingsPanel(v => !v);
            if (showSettingsPanel) return;
            setShowHistoryPanel(false);
            setShowGraphPanel(false);
            setShowSelfTeachingPanel(false);
            setShowComputerUsePanel(false);
            setShowAgentsPanel(false);
            setShowWorkflowsPanel(false);
            setShowMobilePairingPanel(false);
            setShowArtifactsPanel(false);
            setShowProjectsPanel(false);
          }}
          title="Settings"
        >
          <Settings className="w-5 h-5" />
        </Button>
      </div>

      <AnimatePresence>
        {showHistoryPanel && <HistoryPanel sessions={historySessions} currentSessionId={textSessionId} activeSessionIds={activeSessionIds} onNewChat={handleNewChat} onLoadSession={(id) => { loadSession(id); setGraphsBySessionId({}); }} onDeleteSession={deleteSession} />}
      </AnimatePresence>
      <AnimatePresence>
      </AnimatePresence>
      <AnimatePresence>
        {showAgentsPanel && (
          <AgentsPanel
            onClose={() => setShowAgentsPanel(false)}
            activeProjectId={activeProjectId}
            activeProjectName={activeProjectName}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showWorkflowsPanel && (
          <WorkflowsPanel onClose={() => setShowWorkflowsPanel(false)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
      </AnimatePresence>
      <AnimatePresence>
        {showGraphPanel && (
          <GraphPanel
            graphsBySessionId={graphsBySessionId}
            currentSessionId={textSessionId}
            memoryRules={memoryRules}
            rulesGraph={rulesGraph}
            messages={messages}
            onClose={() => setShowGraphPanel(false)}
            onDeleteRule={handleDeleteRule}
            onRefreshRules={loadGraphPanelData}
            rulesStorageBackend={rulesStorageBackend}
            codeGraph={codeGraph}
            onLoadCodeGraph={loadCodeGraph}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showSelfTeachingPanel && <SelfTeachingPanel onClose={() => setShowSelfTeachingPanel(false)} />}
      </AnimatePresence>
      <CaptureTargetPicker
        open={showCaptureTargetPicker}
        onSelect={(target) => {
          setCaptureTarget(target);
          setCuScreenSharing(true);
          setShowCaptureTargetPicker(false);
        }}
        onCancel={() => setShowCaptureTargetPicker(false)}
      />
      <AnimatePresence>
        {showComputerUsePanel && (
          <ComputerUsePanel
            key={showComputerUsePanel ? 'cu-open' : 'cu-closed'}
            onClose={() => setShowComputerUsePanel(false)}
            onScreenShareChange={setCuScreenSharing}
            captureTarget={captureTarget}
            addMessage={addMessage}
            onSessionExecuting={startCuPoller}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showMobilePairingPanel && (
          <MobilePairingPanel onClose={() => setShowMobilePairingPanel(false)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showArtifactsPanel && (
          <ArtifactsPanel
            open={showArtifactsPanel}
            onClose={() => setShowArtifactsPanel(false)}
            activeProjectId={activeProjectId}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showProjectsPanel && (
          <ProjectsPanel
            open={showProjectsPanel}
            onClose={() => setShowProjectsPanel(false)}
            activeProjectId={activeProjectId}
            onActiveProjectChange={_setActiveProjectId}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showSettingsPanel && <SettingsPanel open={showSettingsPanel} onClose={() => setShowSettingsPanel(false)} projectConfig={projectConfig} onProjectConfigured={(cfg) => setProjectConfig({ ...cfg, configured: true })} sessionId={textSessionId} autonomousMode={autonomousMode} onAutonomousModeChange={handleAutonomousModeChange} activeProjectId={activeProjectId} onActiveProjectChange={_setActiveProjectId} />}
      </AnimatePresence>

      <main className={cn(
        "flex-1 flex flex-col overflow-hidden relative",
        // Full-canvas panels replace the chat area entirely.
        (showWorkflowsPanel || showAgentsPanel) && "hidden",
      )}>
<ChatHeader statusText={voice.statusText} isConnected={voice.isConnected} isConnecting={voice.isConnecting} micEnabled={voice.micEnabled} isSharing={voice.isSharing} cuScreenSharing={cuScreenSharing} projectConfig={projectConfig} showSidebar={showSidebar} autonomousMode={autonomousMode} contextBudget={contextBudget} onToggleSidebar={() => setShowSidebar(v => !v)} onToggleMic={voice.toggleMic} onToggleScreenShare={voice.toggleScreenShare} onToggleVision={() => { if (cuScreenSharing) { setCuScreenSharing(false); setCaptureTarget(undefined); } else { setShowCaptureTargetPicker(true); } }} onConnect={voice.handleConnect} onVoiceIdClick={handleVoiceIdClick} onOpenSettings={() => { setShowSettingsPanel(true); setShowHistoryPanel(false); }} onOpenProjects={() => { setShowProjectsPanel(v => !v); }} activeProjectName={activeProjectName} ruleCount={memoryRules.length} onOpenRules={() => { setShowGraphPanel(true); }} missionCount={Object.values(missionsById).filter(m => m.enabled).length} runningMissionCount={Object.values(missionsById).filter(m => m.state === 'running').length} onOpenMissions={() => { const v = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null; if (v) v.scrollTop = 0; }} sessionUsage={sessionUsage} sessionBudget={sessionBudget} sessionBudgetPct={sessionBudgetPct} onOpenBudget={() => { setShowSettingsPanel(true); setShowHistoryPanel(false); }} notifications={notifications} onDismissNotification={dismissNotification} />

        <div className="flex-1 overflow-hidden flex flex-col p-6 max-w-5xl mx-auto w-full">
          <ActiveMissionsBar
            missions={Object.values(missionsById).sort((a, b) => a.goal.localeCompare(b.goal))}
            onMutated={reloadMissions}
          />
          <ScrollArea className="flex-1 pr-4" ref={scrollRef}>
            <div className="flex flex-col gap-6 py-4">
              {/* Show suggestions until the user actually engages. The "Connected to Oasis"
                  system message gets inserted on session start, so we can't gate on length===0. */}
              {messages.filter((m) => m.sender === 'user' || m.sender === 'assistant').length === 0 && !voice.micEnabled && (
                <EmptyChatHints
                  hasMissions={Object.keys(missionsById).length > 0}
                  onPick={(prompt) => { setInputText(prompt); inputRef.current?.focus(); }}
                />
              )}

              {messages.length > 0 && (
                <VirtualizedChatMessages
                  messages={messages}
                  timelineByClientMessageId={timelineByClientMessageId}
                  onOptionClick={handleOptionClick}
                  onReply={(id, text) => { setReplyToMessageId(id); setReplyToMessageText(text); }}
                  onViewTimeline={setSelectedTimelineMessageId}
                  onEditResend={setInputText}
                  onResend={sendText}
                  inputRef={inputRef}
                  loadMore={() => {
                    if (hasMoreHistory && !loadingHistory && textSessionId) {
                      const nextPage = historyPage + 1;
                      loadHistoryPage(textSessionId, nextPage, true);
                    }
                  }}
                  hasMore={hasMoreHistory}
                  loadingMore={loadingHistory}
                />
              )}

              <VoiceBubbles isTranscribing={voice.isTranscribing} liveTranscript={voice.liveTranscript} silenceSeconds={voice.silenceSeconds} />

              <AnimatePresence>
                {isThinking && (
                  <ThinkingOverlay
                    isThinking={isThinking}
                    activeClientMessageId={activeClientMessageId}
                    timelineByClientMessageId={timelineByClientMessageId}
                    messages={messages}
                    onViewTimeline={setSelectedTimelineMessageId}
                    onStop={handleStopPipeline}
                    liveReasoning={activeClientMessageId ? liveReasoningByClientId[activeClientMessageId] || '' : ''}
                  />
                )}
              </AnimatePresence>
            </div>
          </ScrollArea>

          <AnimatePresence>
            {!isNearBottom && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="flex justify-center -mt-2 mb-1 relative z-10">
                <button onClick={scrollToBottom} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/90 border border-slate-700/50 text-xs text-slate-400 hover:text-white hover:bg-slate-700/90 shadow-lg backdrop-blur-sm transition-colors">
                  <ArrowDown className="w-3 h-3" /> New messages
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <ChatInputArea
            inputText={inputText}
            setInputText={setInputText}
            onSend={() => void sendMessage()}
            inputRef={inputRef}
            replyToMessageText={replyToMessageId && replyToMessageText ? replyToMessageText : null}
            onCancelReply={() => { setReplyToMessageId(null); setReplyToMessageText(''); }}
            micEnabled={voice.micEnabled}
            activeProjectId={activeProjectId}
            pendingFiles={quickUpload.pendingFiles}
            onFileAdd={(files) => quickUpload.addFiles(files, activeProjectId)}
            onFileRemove={quickUpload.removeFile}
            topToolbar={
              <RolePicker
                activeProjectId={activeProjectId}
                value={activeRoleId}
                onChange={setActiveRoleId}
              />
            }
          >
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 rounded-2xl bg-slate-900/50 border border-slate-800 overflow-hidden">
              {voice.isSpeaking ? <WaveformVisualizer audioLevel={voice.audioLevel} isActive={voice.isSpeaking} tick={tick} /> : <ListeningOrb />}
            </motion.div>
          </ChatInputArea>
        </div>
      </main>

      <Toaster />
      {voiceIdModalOpen && <VoiceIdModal onClose={() => { setVoiceIdModalOpen(false); }} voiceAgentUrl={VOICE_AGENT_URL} micEnabled={voice.micEnabled} setMicSilent={voice.setMicSilent} />}

      <AnimatePresence>
        {selectedTimelineMessageId && <TimelineOverlay sessionId={textSessionId} events={timelineByClientMessageId[selectedTimelineMessageId] || []} onClose={() => setSelectedTimelineMessageId(null)} />}
      </AnimatePresence>
    </div>
  );
}
