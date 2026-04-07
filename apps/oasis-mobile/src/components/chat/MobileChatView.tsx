import { useEffect, useRef } from 'react';
import { Bot, Mic } from 'lucide-react';
import type { Message, PairingState, ProjectConfig } from '../../lib/types';
import { MobileChatMessage } from './MobileChatMessage';
import { MobileChatInput } from './MobileChatInput';
import { PairingStatus } from '../pairing/PairingStatus';
import type { VoiceChatState } from '../../hooks/useVoiceChat';

interface MobileChatViewProps {
  messages: Message[];
  isThinking: boolean;
  streamingStatus: string | null;
  pairing: PairingState;
  projectConfig: ProjectConfig | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  onOpenSidebar: () => void;
  voice?: VoiceChatState;
}

export function MobileChatView({
  messages,
  isThinking,
  streamingStatus,
  pairing,
  projectConfig,
  onSend,
  onCancel,
  onOpenSidebar,
  voice,
}: MobileChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages or streaming updates
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isThinking]);

  return (
    <div className="h-full flex flex-col bg-[#030712]">
      {/* Header */}
      <header className="h-14 border-b border-slate-800 flex items-center justify-between px-4 bg-[#0a0f1a] flex-shrink-0">
        <button
          onClick={onOpenSidebar}
          className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="text-center flex-1 min-w-0">
          <h1 className="text-base font-semibold text-white truncate">
            Oasis <span className="text-cyan-400">Mobile</span>
            <span className="text-[9px] text-slate-600 font-mono ml-1">{__BUILD_NUMBER__}</span>
          </h1>
          {projectConfig?.configured && projectConfig.project_name && (
            <p className="text-[11px] text-slate-400 truncate">
              {projectConfig.project_name}
              {projectConfig.frameworks && projectConfig.frameworks.length > 0 && (
                <span className="text-slate-500"> · {projectConfig.frameworks[0]}</span>
              )}
            </p>
          )}
        </div>
        {/* Voice status dot */}
        <div className="w-8 flex items-center justify-center">
          {voice?.isConnected && (
            <div className={`w-2 h-2 rounded-full ${voice.micEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          )}
        </div>
      </header>

      {/* Connection status */}
      <PairingStatus connected={pairing.paired} expiresAt={pairing.expiresAt} />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-full bg-slate-800 flex items-center justify-center mb-4">
              <Bot className="w-7 h-7 text-slate-600" />
            </div>
            <p className="text-sm text-slate-400 mb-4">
              {projectConfig?.configured
                ? `Connected to ${projectConfig.project_name}. Send a message to start.`
                : 'Send a message to start chatting'}
            </p>
            {voice && !voice.isConnected && (
              <button
                onClick={voice.connect}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white text-xs transition-colors"
              >
                <Mic className="w-3.5 h-3.5" />
                Enable voice chat
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg) => (
              <MobileChatMessage key={msg.id} message={msg} />
            ))}
            {/* Streaming status indicator */}
            {isThinking && streamingStatus && !messages.some(m => m.isStreaming && (m.text || m.thinking)) && (
              <div className="flex justify-start">
                <div className="bg-slate-800 rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-xs text-slate-400">{streamingStatus}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <MobileChatInput
        onSend={onSend}
        onCancel={onCancel}
        isThinking={isThinking}
        disabled={!pairing.paired}
        voiceConnected={voice?.isConnected}
        micEnabled={voice?.micEnabled}
        audioLevel={voice?.audioLevel}
        isSpeaking={voice?.isSpeaking}
        isTranscribing={voice?.isTranscribing}
        liveTranscript={voice?.liveTranscript}
        voiceStatusText={voice?.statusText}
        onToggleMic={voice?.toggleMic}
        onVoiceConnect={voice?.connect}
      />
    </div>
  );
}
