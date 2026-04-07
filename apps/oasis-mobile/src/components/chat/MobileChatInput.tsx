import { useState, useRef, useCallback } from 'react';
import { Send, X, Mic, MicOff, Radio } from 'lucide-react';

interface MobileChatInputProps {
  onSend: (text: string) => void;
  onCancel: () => void;
  isThinking: boolean;
  disabled: boolean;
  // Voice props
  voiceConnected?: boolean;
  micEnabled?: boolean;
  audioLevel?: number;
  isSpeaking?: boolean;
  isTranscribing?: boolean;
  liveTranscript?: string;
  voiceStatusText?: string;
  onToggleMic?: () => void;
  onVoiceConnect?: () => void;
}

export function MobileChatInput({
  onSend, onCancel, isThinking, disabled,
  voiceConnected, micEnabled, audioLevel = 0, isSpeaking,
  isTranscribing, liveTranscript, voiceStatusText,
  onToggleMic, onVoiceConnect,
}: MobileChatInputProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [text, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  };

  const handleMicPress = useCallback(() => {
    if (!voiceConnected && onVoiceConnect) {
      onVoiceConnect();
      // Auto-toggle mic after connection
      setTimeout(() => onToggleMic?.(), 500);
      return;
    }
    onToggleMic?.();
  }, [voiceConnected, onVoiceConnect, onToggleMic]);

  // Mic is actively recording
  const isRecording = micEnabled && voiceConnected;

  return (
    <div className="border-t border-slate-800 bg-[#0a0f1a] p-3 pb-safe">
      {/* Voice status bar — shown when recording or transcribing */}
      {isRecording && (
        <div className="mb-2 flex items-center gap-2 px-2">
          {/* Pulse indicator */}
          <div className="relative flex items-center justify-center">
            <div
              className="w-3 h-3 rounded-full bg-red-500"
              style={{
                boxShadow: `0 0 ${4 + audioLevel * 16}px ${2 + audioLevel * 8}px rgba(239, 68, 68, ${0.3 + audioLevel * 0.4})`,
              }}
            />
            {isSpeaking && (
              <div className="absolute w-5 h-5 rounded-full border border-red-400 animate-ping" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            {liveTranscript ? (
              <p className="text-xs text-slate-300 truncate italic">"{liveTranscript}"</p>
            ) : isTranscribing ? (
              <p className="text-xs text-cyan-400 animate-pulse">Transcribing...</p>
            ) : isSpeaking ? (
              <p className="text-xs text-emerald-400">Listening...</p>
            ) : (
              <p className="text-xs text-slate-500">{voiceStatusText || 'Speak now...'}</p>
            )}
          </div>

          {/* Audio level bar */}
          <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-400 rounded-full transition-all duration-75"
              style={{ width: `${Math.min(100, audioLevel * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={isThinking ? 'Thinking...' : isRecording ? 'Or type a message...' : 'Message Oasis...'}
          disabled={disabled || isThinking}
          rows={1}
          className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-50"
        />

        {/* Mic button */}
        {onToggleMic && (
          <button
            onClick={handleMicPress}
            disabled={disabled}
            className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all ${
              isRecording
                ? 'bg-red-600 hover:bg-red-700 shadow-lg shadow-red-900/30'
                : voiceConnected
                  ? 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  : 'bg-slate-700/50 hover:bg-slate-600 text-slate-500'
            }`}
          >
            {isRecording ? (
              <Radio className="w-5 h-5 text-white animate-pulse" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
        )}

        {/* Send / Cancel button */}
        {isThinking ? (
          <button
            onClick={onCancel}
            className="w-10 h-10 rounded-xl bg-red-600 hover:bg-red-700 flex items-center justify-center flex-shrink-0 transition-colors"
          >
            <X className="w-5 h-5 text-white" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled}
            className="w-10 h-10 rounded-xl bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-700 disabled:opacity-50 flex items-center justify-center flex-shrink-0 transition-colors"
          >
            <Send className="w-5 h-5 text-white" />
          </button>
        )}
      </div>
    </div>
  );
}
