import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, PairingState, ToolCallInfo } from '../lib/types';
import { streamEncryptedMessage } from '../lib/interaction-api';
import { createOutboxStore, type OutboxItem } from '../lib/outbox';
import { OutboxRunner, type DeliveryResult } from '../lib/outbox-runner';

const userId = (queueId: string) => `user-${queueId}`;
const assistantId = (queueId: string) => `assistant-${queueId}`;

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function useEncryptedChat(pairing: PairingState, projectId?: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [online, setOnline] = useState(isOnline);

  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;
  const runnerRef = useRef<OutboxRunner | null>(null);

  /** Show every outbox message the chat doesn't show yet (after a reload, or a cleared chat). */
  const showOutbox = useCallback((items: OutboxItem[]) => {
    setMessages(prev => {
      const byId = new Map(items.map(i => [userId(i.id), i]));
      let changed = false;
      const next = prev.map(m => {
        const item = m.queueId ? byId.get(m.id) : undefined;
        if (m.queueId && !item && m.pending) { changed = true; return null; } // withdrawn
        if (item && m.pending !== !item.accepted) { changed = true; return { ...m, pending: !item.accepted }; }
        return m;
      }).filter((m): m is Message => m !== null);
      const shown = new Set(next.map(m => m.id));
      for (const item of items) {
        if (shown.has(userId(item.id))) continue;
        changed = true;
        next.push({
          id: userId(item.id), queueId: item.id, text: item.text, sender: 'user',
          timestamp: new Date(item.createdAt).toISOString(), pending: !item.accepted,
        });
      }
      return changed ? next : prev;
    });
  }, []);

  const deliver = useCallback(async (item: OutboxItem, ctl: { signal: AbortSignal; markAccepted(): void; setCursor(c: string): void }): Promise<DeliveryResult> => {
    const id = assistantId(item.id);
    let receivedStreamedText = false;

    const updateAssistant = (updater: (msg: Message) => Message) => {
      setMessages(prev => {
        const exists = prev.some(m => m.id === id);
        const base: Message[] = exists ? prev : [...prev, {
          id, text: '', sender: 'assistant', timestamp: new Date().toISOString(),
          isStreaming: true, thinking: '', thinkingDone: false, toolCalls: [],
        }];
        return base.map(m => (m.id === id ? updater(m) : m));
      });
    };
    const accepted = () => {
      ctl.markAccepted();
      setMessages(prev => prev.map(m => (m.id === userId(item.id) ? { ...m, pending: false } : m)));
      setIsThinking(true);
      setStreamingStatus(s => s || 'Thinking...');
    };
    if (item.accepted) accepted();

    try {
      const outcome = await streamEncryptedMessage(item.text, pairingRef.current, {
        onAccepted: accepted,
        onCursor: ctl.setCursor,
        onResponseChunk: (fullText) => {
          receivedStreamedText = true;
          setStreamingStatus('Responding...');
          updateAssistant(m => ({ ...m, text: fullText, error: undefined }));
        },
        onThinkingChunk: (chunk) => {
          setStreamingStatus('Thinking...');
          updateAssistant(m => ({ ...m, thinking: (m.thinking || '') + chunk }));
        },
        onThinkingLayer: (fullText) => {
          setStreamingStatus('Thinking...');
          updateAssistant(m => ({ ...m, thinking: fullText }));
        },
        onThinkingDone: () => updateAssistant(m => ({ ...m, thinkingDone: true })),
        onToolCallStarted: (toolName) => {
          setStreamingStatus(`Using ${toolName}...`);
          updateAssistant(m => ({ ...m, toolCalls: [...(m.toolCalls || []), { name: toolName, status: 'running' as const }] }));
        },
        onToolCallCompleted: (toolName) => {
          updateAssistant(m => ({
            ...m,
            toolCalls: (m.toolCalls || []).map((tc: ToolCallInfo) =>
              tc.name === toolName && tc.status === 'running' ? { ...tc, status: 'completed' as const } : tc,
            ),
          }));
        },
        onFinalResponse: (response) => {
          updateAssistant(m => ({
            ...m,
            // Only use the final response text if we didn't get streamed chunks
            text: receivedStreamedText ? m.text : (response.response || m.text),
            confidence: response.confidence,
            isStreaming: false,
            error: undefined,
            thinkingDone: m.thinking ? true : m.thinkingDone,
          }));
        },
      }, {
        clientMessageId: item.id,
        resumeAfter: item.cursor,
        signal: ctl.signal,
        projectId: item.projectId,
      });

      switch (outcome.status) {
        case 'completed':
          return 'sent';
        case 'aborted':
          return 'dropped';
        case 'failed':
          // Keep whatever text already streamed in; say what went wrong under it.
          setMessages(prev => prev.map(m => (m.id === userId(item.id) ? { ...m, pending: false } : m)));
          updateAssistant(m => ({ ...m, isStreaming: false, error: outcome.error }));
          return 'dropped';
        case 'expired':
          // Stays in the outbox and goes out once the phone is paired again.
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, isStreaming: false } : m)));
          return 'retry';
        case 'offline':
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, isStreaming: false } : m)));
          return 'retry';
      }
    } finally {
      setIsThinking(false);
      setStreamingStatus(null);
    }
  }, []);

  // One runner per mount; it reads the persisted outbox and sends what's left.
  useEffect(() => {
    const runner = new OutboxRunner({
      store: createOutboxStore(),
      deliver,
      canSend: () => pairingRef.current.paired && isOnline(),
      onChange: showOutbox,
    });
    runnerRef.current = runner;
    void runner.ready().then(() => runner.kick());

    const wake = () => { setOnline(isOnline()); void runner.kick(); };
    const offline = () => setOnline(false);
    const visible = () => { if (!document.hidden) void runner.kick(); };
    window.addEventListener('online', wake);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      runner.dispose();
      runnerRef.current = null;
    };
  }, [deliver, showOutbox]);

  // Paired (again): send whatever waited.
  useEffect(() => {
    if (pairing.paired) void runnerRef.current?.kick();
  }, [pairing.paired, pairing.pairingId]);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const runner = runnerRef.current;
    if (!trimmed || !runner) return;
    await runner.enqueue(trimmed, projectId);
  }, [projectId]);

  /** Withdraw a message that is still waiting to be sent. */
  const cancelQueued = useCallback(async (queueId: string) => {
    await runnerRef.current?.cancel(queueId);
  }, []);

  const cancelRequest = useCallback(() => {
    void runnerRef.current?.stopCurrent();
    setIsThinking(false);
    setStreamingStatus(null);
    setMessages(prev =>
      prev.map(m =>
        m.isStreaming ? { ...m, isStreaming: false, text: m.text || 'Cancelled' } : m,
      ),
    );
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setActiveSessionId(null);
    // Messages still waiting to go out stay visible.
    if (runnerRef.current) showOutbox(runnerRef.current.items);
  }, [showOutbox]);

  const loadHistoryMessages = useCallback((msgs: Message[], sessionId: string) => {
    setMessages(msgs);
    setActiveSessionId(sessionId);
    if (runnerRef.current) showOutbox(runnerRef.current.items);
  }, [showOutbox]);

  /** Add a message directly (used by voice chat to inject transcripts/responses) */
  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  /** Update a message by ID */
  const updateMessage = useCallback((id: string, updater: (msg: Message) => Message) => {
    setMessages(prev => prev.map(m => (m.id === id ? updater(m) : m)));
  }, []);

  return {
    messages, isThinking, streamingStatus, activeSessionId, online,
    sendMessage, cancelQueued, cancelRequest, clearMessages, loadHistoryMessages,
    addMessage, updateMessage,
    setIsThinking, setStreamingStatus,
  };
}
