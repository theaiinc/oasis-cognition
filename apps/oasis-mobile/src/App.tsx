import { useState, useCallback, useEffect } from 'react';
import { usePairing } from './hooks/usePairing';
import { useEncryptedChat } from './hooks/useEncryptedChat';
import { useVoiceChat } from './hooks/useVoiceChat';
import { QRScannerView } from './components/pairing/QRScannerView';
import { MobileChatView } from './components/chat/MobileChatView';
import { MobileSidebar } from './components/sidebar/MobileSidebar';
import { MobileComputerUse } from './components/computer-use/MobileComputerUse';
import type { ProjectConfig, ChatSession, Message } from './lib/types';

// Build number injected by Vite at build time
const BUILD_NUMBER = __BUILD_NUMBER__;

export default function App() {
  const { pairing, error, loading, initializing, sessionEnded, pairFromScan, disconnect, clearError } = usePairing();
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(null);

  // Fetch project config once paired
  const fetchProjectConfig = useCallback(() => {
    if (!pairing.paired || !pairing.tunnelUrl) return;

    fetch(`${pairing.tunnelUrl}/relay/project/config`, { signal: AbortSignal.timeout(10000) })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.success && data.config) {
          setProjectConfig({
            configured: true,
            project_name: data.config.project_name,
            project_path: data.config.project_path,
            project_type: data.config.project_type,
            tech_stack: data.config.tech_stack,
            frameworks: data.config.frameworks,
            project_id: data.config.project_id,
          });
        }
      })
      .catch(() => { /* dev-agent not running or no project configured */ });
  }, [pairing.paired, pairing.tunnelUrl]);

  useEffect(() => {
    fetchProjectConfig();
  }, [fetchProjectConfig]);

  // Poll for active project changes (desktop may switch projects independently)
  useEffect(() => {
    if (!pairing.paired || !pairing.tunnelUrl) return;
    const interval = setInterval(() => {
      fetch(`${pairing.tunnelUrl}/relay/project/config`, { signal: AbortSignal.timeout(5000) })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.success && data.config) {
            const newId = data.config.project_id;
            // Only update if the active project changed (avoids unnecessary re-renders)
            setProjectConfig(prev => {
              if (prev?.project_id === newId) return prev;
              return {
                configured: true,
                project_name: data.config.project_name,
                project_path: data.config.project_path,
                project_type: data.config.project_type,
                tech_stack: data.config.tech_stack,
                frameworks: data.config.frameworks,
                project_id: newId,
              };
            });
          }
        })
        .catch(() => { /* ignore */ });
    }, 5000);
    return () => clearInterval(interval);
  }, [pairing.paired, pairing.tunnelUrl]);

  const handleProjectSwitch = useCallback((projectId: string) => {
    // Optimistically update the project_id so the sidebar shows the selection immediately
    setProjectConfig(prev => prev ? { ...prev, project_id: projectId } : { configured: false, project_id: projectId });
    // Then refresh full config from backend (activation may still be in progress)
    setTimeout(fetchProjectConfig, 800);
  }, [fetchProjectConfig]);

  const activeProjectId = projectConfig?.project_id;
  const {
    messages, isThinking, streamingStatus,
    sendMessage, cancelRequest, clearMessages, loadHistoryMessages,
    activeSessionId, addMessage, updateMessage,
    setIsThinking, setStreamingStatus,
  } = useEncryptedChat(pairing, activeProjectId);

  // Voice chat integration — shares message list with text chat
  const voice = useVoiceChat({
    pairing,
    sessionId: activeSessionId,
    onTranscript: useCallback((text: string, cmid: string) => {
      addMessage({
        id: `user-voice-${cmid}`,
        text,
        sender: 'user',
        timestamp: new Date().toISOString(),
      });
    }, [addMessage]),
    onThinking: useCallback((cmid: string) => {
      setIsThinking(true);
      setStreamingStatus('Thinking...');
      addMessage({
        id: `assistant-voice-${cmid}`,
        text: '',
        sender: 'assistant',
        timestamp: new Date().toISOString(),
        isStreaming: true,
        thinking: '',
        thinkingDone: false,
        toolCalls: [],
      });
    }, [addMessage, setIsThinking, setStreamingStatus]),
    onResponseChunk: useCallback((fullText: string, cmid: string) => {
      setStreamingStatus('Responding...');
      updateMessage(`assistant-voice-${cmid}`, m => ({ ...m, text: fullText }));
    }, [updateMessage, setStreamingStatus]),
    onResponse: useCallback((text: string, confidence: number, cmid: string) => {
      setIsThinking(false);
      setStreamingStatus(null);
      updateMessage(`assistant-voice-${cmid}`, m => ({
        ...m,
        text: text || m.text,
        confidence,
        isStreaming: false,
        thinkingDone: m.thinking ? true : m.thinkingDone,
      }));
    }, [updateMessage, setIsThinking, setStreamingStatus]),
    onStreamEvent: useCallback((eventType: string, payload: Record<string, unknown>) => {
      // Handle thinking chunks from SSE
      const cmid = (payload.client_message_id as string) || '';
      const msgId = `assistant-voice-${cmid}`;
      if (eventType === 'ThoughtChunkGenerated') {
        const chunk = (payload.chunk as string) || '';
        if (chunk) updateMessage(msgId, m => ({ ...m, thinking: (m.thinking || '') + chunk }));
      } else if (eventType === 'ThoughtLayerGenerated') {
        const thoughts = (payload.thoughts as string) || '';
        if (thoughts) updateMessage(msgId, m => ({ ...m, thinking: thoughts }));
      } else if (eventType === 'ThoughtsValidated') {
        updateMessage(msgId, m => ({ ...m, thinkingDone: true }));
      } else if (eventType === 'ToolCallStarted') {
        const name = (payload.tool_name as string) || (payload.name as string) || 'tool';
        setStreamingStatus(`Using ${name}...`);
        updateMessage(msgId, m => ({
          ...m,
          toolCalls: [...(m.toolCalls || []), { name, status: 'running' as const }],
        }));
      } else if (eventType === 'ToolCallCompleted') {
        const name = (payload.tool_name as string) || (payload.name as string) || 'tool';
        updateMessage(msgId, m => ({
          ...m,
          toolCalls: (m.toolCalls || []).map(tc =>
            tc.name === name && tc.status === 'running' ? { ...tc, status: 'completed' as const } : tc
          ),
        }));
      } else if (eventType === 'ResponseChunkGenerated') {
        const fullText = (payload.full_text as string) || '';
        if (fullText) {
          setStreamingStatus('Responding...');
          updateMessage(msgId, m => ({ ...m, text: fullText }));
        }
      }
    }, [updateMessage, setStreamingStatus]),
    onError: useCallback((message: string) => {
      console.warn('[Voice]', message);
    }, []),
  });

  const [showScanner, setShowScanner] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showComputerUse, setShowComputerUse] = useState(false);

  const handleScanQR = useCallback(() => {
    setShowScanner(true);
    clearError();
  }, [clearError]);

  const handleScan = useCallback((data: string) => {
    pairFromScan(data);
    setShowScanner(false);
  }, [pairFromScan]);

  const handleSessionSelect = useCallback((session: ChatSession) => {
    if (!pairing.tunnelUrl) return;

    // Fetch messages for this session
    fetch(`${pairing.tunnelUrl}/relay/sessions/${session.session_id}/messages`, {
      signal: AbortSignal.timeout(15000),
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.messages && Array.isArray(data.messages)) {
          const msgs: Message[] = data.messages.map((m: any, i: number) => ({
            id: `hist-${session.session_id}-${i}`,
            text: m.content || '',
            sender: m.role === 'user' ? 'user' as const : 'assistant' as const,
            timestamp: m.timestamp || session.created_at,
          }));
          loadHistoryMessages(msgs, session.session_id);
        }
      })
      .catch(() => { /* ignore */ });
  }, [pairing.tunnelUrl, loadHistoryMessages]);

  const handleNewChat = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

  // ── Loading / connecting screen (during auto-pair from URL hash or session restore) ──
  if (initializing || (loading && !pairing.paired)) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#0a0f1a] px-6">
        <div className="flex flex-col items-center gap-6">
          <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
            <svg className="w-8 h-8 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-white mb-2">Connecting to Oasis</h1>
            <p className="text-sm text-slate-400">Establishing secure session...</p>
          </div>
          <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          {error && (
            <div className="w-full max-w-sm bg-red-900/30 border border-red-800 rounded-lg p-3 text-center">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}
        </div>
        <p className="absolute bottom-4 text-[10px] text-slate-700">Build {BUILD_NUMBER}</p>
      </div>
    );
  }

  // ── Session ended overlay (revoked, expired, or stale page) ──
  if (sessionEnded && !pairing.paired) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#030712] px-6 text-center">
        <div className="w-20 h-20 rounded-full bg-slate-800/60 flex items-center justify-center mb-6">
          <svg className="w-10 h-10 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">Session Ended</h2>
        <p className="text-sm text-slate-400 mb-2 max-w-xs">
          This session is no longer active. Scan a new QR code from your desktop to reconnect.
        </p>
        <p className="text-xs text-slate-600 mb-8">
          The connection was either revoked, expired, or the desktop is offline.
        </p>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={() => window.close()}
            className="bg-slate-800 hover:bg-slate-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors border border-slate-700"
          >
            Close This Page
          </button>
        </div>
        <p className="absolute bottom-4 text-[10px] text-slate-700">Build {BUILD_NUMBER}</p>
      </div>
    );
  }

  // ── Session expired overlay ──
  if (error && error.includes('expired')) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#030712] px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">Session Expired</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <button
          onClick={() => { clearError(); setShowScanner(true); }}
          className="bg-cyan-600 hover:bg-cyan-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
        >
          Scan New QR Code
        </button>
        <p className="absolute bottom-4 text-[10px] text-slate-700">Build {BUILD_NUMBER}</p>
      </div>
    );
  }

  // ── Not paired — show QR scanner ──
  if (!pairing.paired) {
    return (
      <QRScannerView
        onScan={handleScan}
        loading={loading}
        error={error}
      />
    );
  }

  // ── Paired — show chat view ──
  return (
    <div className="h-full relative">
      {showComputerUse && pairing.tunnelUrl ? (
        <MobileComputerUse
          tunnelUrl={pairing.tunnelUrl}
          voiceChat={voice}
          onClose={() => setShowComputerUse(false)}
        />
      ) : showScanner ? (
        <div className="h-full relative">
          <QRScannerView onScan={handleScan} loading={loading} error={error} />
          <button
            onClick={() => setShowScanner(false)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 flex items-center justify-center text-white z-50"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <MobileChatView
          messages={messages}
          isThinking={isThinking}
          streamingStatus={streamingStatus}
          pairing={pairing}
          projectConfig={projectConfig}
          onSend={sendMessage}
          onCancel={cancelRequest}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      )}

      <MobileSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onScanQR={handleScanQR}
        onDisconnect={disconnect}
        paired={pairing.paired}
        tunnelUrl={pairing.tunnelUrl}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        projectConfig={projectConfig}
        onProjectSwitch={handleProjectSwitch}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        onOpenComputerUse={() => setShowComputerUse(true)}
      />
    </div>
  );
}
