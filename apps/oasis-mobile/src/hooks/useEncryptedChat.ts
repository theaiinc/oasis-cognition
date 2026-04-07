import { useState, useCallback, useRef } from 'react';
import type { Message, PairingState, ToolCallInfo } from '../lib/types';
import { streamEncryptedMessage, SessionExpiredError } from '../lib/interaction-api';

export function useEncryptedChat(pairing: PairingState, projectId?: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track whether we received any streamed response text (to avoid duplication)
  const receivedStreamedTextRef = useRef(false);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || !pairing.paired) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      text: text.trim(),
      sender: 'user',
      timestamp: new Date().toISOString(),
    };

    const assistantId = `assistant-${Date.now()}`;
    receivedStreamedTextRef.current = false;

    // Add user message only — assistant message is created on first streaming event
    setMessages(prev => [...prev, userMsg]);
    setIsThinking(true);
    setStreamingStatus('Thinking...');

    const controller = new AbortController();
    abortRef.current = controller;
    let assistantCreated = false;

    const ensureAssistant = () => {
      if (!assistantCreated) {
        assistantCreated = true;
        setMessages(prev => [
          ...prev,
          {
            id: assistantId,
            text: '',
            sender: 'assistant' as const,
            timestamp: new Date().toISOString(),
            isStreaming: true,
            thinking: '',
            thinkingDone: false,
            toolCalls: [],
          },
        ]);
      }
    };

    const updateAssistant = (updater: (msg: Message) => Message) => {
      ensureAssistant();
      setMessages(prev =>
        prev.map(m => (m.id === assistantId ? updater(m) : m)),
      );
    };

    try {
      await streamEncryptedMessage(text.trim(), pairing, {
        onResponseChunk: (fullText: string) => {
          receivedStreamedTextRef.current = true;
          setStreamingStatus('Responding...');
          updateAssistant(m => ({ ...m, text: fullText }));
        },
        onThinkingChunk: (chunk: string) => {
          setStreamingStatus('Thinking...');
          // Incremental chunk — append to existing thinking text
          updateAssistant(m => ({ ...m, thinking: (m.thinking || '') + chunk }));
        },
        onThinkingLayer: (fullText: string) => {
          setStreamingStatus('Thinking...');
          // Full layer text — replace (it's the complete thought for this layer)
          updateAssistant(m => ({ ...m, thinking: fullText }));
        },
        onThinkingDone: () => {
          updateAssistant(m => ({ ...m, thinkingDone: true }));
        },
        onToolCallStarted: (toolName: string) => {
          setStreamingStatus(`Using ${toolName}...`);
          updateAssistant(m => ({
            ...m,
            toolCalls: [
              ...(m.toolCalls || []),
              { name: toolName, status: 'running' as const },
            ],
          }));
        },
        onToolCallCompleted: (toolName: string) => {
          updateAssistant(m => ({
            ...m,
            toolCalls: (m.toolCalls || []).map((tc: ToolCallInfo) =>
              tc.name === toolName && tc.status === 'running'
                ? { ...tc, status: 'completed' as const }
                : tc,
            ),
          }));
        },
        onFinalResponse: (response) => {
          updateAssistant(m => ({
            ...m,
            // Only use the final response text if we didn't get streamed chunks
            text: receivedStreamedTextRef.current ? m.text : (response.response || m.text),
            confidence: response.confidence,
            isStreaming: false,
            thinkingDone: m.thinking ? true : m.thinkingDone,
          }));
        },
        onError: (err) => {
          if (err.name === 'AbortError') return;
          if (err instanceof SessionExpiredError) return;

          updateAssistant(m => ({
            ...m,
            text: `Error: ${err.message}`,
            isStreaming: false,
          }));
        },
      }, {
        signal: controller.signal,
        projectId,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      updateAssistant(m => ({
        ...m,
        text: m.text || `Error: ${err.message}`,
        isStreaming: false,
      }));
    } finally {
      setIsThinking(false);
      setStreamingStatus(null);
      abortRef.current = null;
    }
  }, [pairing, projectId]);

  const cancelRequest = useCallback(() => {
    abortRef.current?.abort();
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
  }, []);

  const loadHistoryMessages = useCallback((msgs: Message[], sessionId: string) => {
    setMessages(msgs);
    setActiveSessionId(sessionId);
  }, []);

  /** Add a message directly (used by voice chat to inject transcripts/responses) */
  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  /** Update a message by ID */
  const updateMessage = useCallback((id: string, updater: (msg: Message) => Message) => {
    setMessages(prev => prev.map(m => (m.id === id ? updater(m) : m)));
  }, []);

  return {
    messages, isThinking, streamingStatus, activeSessionId,
    sendMessage, cancelRequest, clearMessages, loadHistoryMessages,
    addMessage, updateMessage,
    setIsThinking, setStreamingStatus,
  };
}
