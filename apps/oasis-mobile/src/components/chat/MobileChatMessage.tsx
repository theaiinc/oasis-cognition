import { useState } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownMessage } from '@oasis/ui-kit';
import { ChevronDown, ChevronRight, Brain, Wrench, Loader2, CheckCircle2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Message } from '../../lib/types';

interface MobileChatMessageProps {
  message: Message;
}

export function MobileChatMessage({ message }: MobileChatMessageProps) {
  const isUser = message.sender === 'user';
  const isError = !isUser && message.text.startsWith('Error:');

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-cyan-600 text-white rounded-br-md'
            : isError
              ? 'bg-red-900/30 border border-red-800 text-red-300 rounded-bl-md'
              : 'bg-slate-800 text-slate-200 rounded-bl-md'
        }`}
      >
        {/* Thinking section */}
        {!isUser && message.thinking && (
          <ThinkingSection
            thinking={message.thinking}
            done={message.thinkingDone ?? false}
            isStreaming={message.isStreaming ?? false}
          />
        )}

        {/* Tool call indicators */}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {message.toolCalls.map((tc, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-slate-400">
                {tc.status === 'running' ? (
                  <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                ) : (
                  <CheckCircle2 className="w-3 h-3 text-green-400" />
                )}
                <Wrench className="w-3 h-3" />
                <span className="truncate">{tc.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Main content */}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : message.text ? (
          <MarkdownMessage text={message.text} />
        ) : null}

        {message.confidence != null && message.confidence > 0 && (
          <p className="text-[10px] mt-1 text-slate-500">
            confidence: {(message.confidence * 100).toFixed(0)}%
          </p>
        )}
        {message.text && (
          <p className={`text-[10px] mt-1 ${isUser ? 'text-cyan-200/60' : 'text-slate-500'}`}>
            {formatTime(message.timestamp)}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible thinking section with full-screen dialog.
 * While streaming: expanded with live text and pulse indicator.
 * When done: collapsed with tappable "View full thoughts" that opens dialog.
 */
function ThinkingSection({
  thinking,
  done,
  isStreaming,
}: {
  thinking: string;
  done: boolean;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(!done);
  const [dialogOpen, setDialogOpen] = useState(false);

  const showExpanded = !done || expanded;
  const thinkingLines = thinking.split('\n').length;

  return (
    <>
      <div className="mb-2">
        <button
          onClick={() => {
            if (done) setExpanded(prev => !prev);
          }}
          className={`flex items-center gap-1.5 text-xs w-full text-left ${
            done ? 'text-slate-500 hover:text-slate-400 cursor-pointer' : 'text-cyan-400 cursor-default'
          }`}
        >
          {!done ? (
            <Brain className="w-3.5 h-3.5 animate-pulse" />
          ) : showExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <span className="font-medium">
            {done
              ? `Thought process (${thinkingLines} line${thinkingLines !== 1 ? 's' : ''})`
              : 'Thinking...'}
          </span>
        </button>

        {showExpanded && (
          <div className={`mt-1.5 text-xs leading-relaxed border-l-2 pl-2.5 ${
            done ? 'border-slate-700 text-slate-500' : 'border-cyan-800 text-slate-400'
          } max-h-60 overflow-y-auto`}>
            <p className="whitespace-pre-wrap break-words">
              {thinking.length > 600 && done ? thinking.slice(0, 600) + '...' : thinking}
            </p>
            {!done && isStreaming && (
              <span className="inline-block w-1.5 h-3 bg-cyan-400 animate-pulse ml-0.5 align-text-bottom" />
            )}
          </div>
        )}

        {/* View full button when content is long */}
        {done && thinking.length > 200 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDialogOpen(true);
            }}
            className="mt-2 text-[11px] text-cyan-500 hover:text-cyan-400 font-medium px-2 py-1 rounded bg-cyan-950/30 border border-cyan-800/20"
          >
            View full thoughts
          </button>
        )}
      </div>

      {/* Full-screen thinking dialog — rendered via portal to escape parent overflow */}
      {dialogOpen && createPortal(
        <ThinkingDialog
          thinking={thinking}
          onClose={() => setDialogOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}

/**
 * Full-screen overlay dialog for reading complete thoughts.
 */
function ThinkingDialog({
  thinking,
  onClose,
}: {
  thinking: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col"
      style={{ backgroundColor: 'rgba(3, 7, 18, 0.98)' }}
    >
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-slate-800 bg-[#0a0f1a] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Thought Process</h2>
        </div>
        <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-white"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
          {thinking}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-800 bg-[#0a0f1a]">
        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
