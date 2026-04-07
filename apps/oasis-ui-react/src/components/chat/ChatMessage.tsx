import { motion } from 'framer-motion';
import { User, Bot, Terminal, Mic, Reply, FileText } from 'lucide-react';
import axios from 'axios';
import { useToast } from '@/hooks/use-toast';
import { cn, getErrorMessage, timelineClientKeyForMessage } from '@/lib/utils';
import type { Message, TimelineEvent } from '@/lib/types';
import { OASIS_BASE_URL } from '@/lib/constants';
import { parseMessageMentions } from '@/lib/mention-utils';
import { MarkdownMessage } from '@oasis/ui-kit';
import { DiffViewer } from './DiffViewer';
import { ActivityStream } from './ActivityStream';
import { ToolCallsScrollContainer } from './ToolCallsScrollContainer';
import { ThinkingCard } from '@/components/timeline';

interface ChatMessageProps {
  message: Message;
  timelineEvents: TimelineEvent[];
  onOptionClick: (option: string) => void;
  onReply: (id: string, text: string) => void;
  onViewTimeline: (id: string) => void;
  onEditResend: (text: string) => void;
  onResend: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function ChatMessage({
  message,
  timelineEvents,
  onOptionClick,
  onReply,
  onViewTimeline,
  onEditResend,
  onResend,
  inputRef,
}: ChatMessageProps) {
  const { toast } = useToast();
  const m = message;
  const toolStarts = timelineEvents.filter(e => e.event_type === 'ToolCallStarted');
  const thoughts = timelineEvents.filter(e => e.event_type === 'ThoughtsValidated');
  const thoughtLayers = timelineEvents.filter(e => e.event_type === 'ThoughtLayerGenerated');
  const hasStreamActivity = toolStarts.length > 0 || thoughts.length > 0 || thoughtLayers.length > 0;
  const diffEvent = timelineEvents.find(e => e.event_type === 'ToolCallCompleted' && (e.payload as Record<string, unknown>).diff);

  return (
    <motion.div
      key={m.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn("flex gap-4 max-w-[85%]", m.sender === 'user' ? "ml-auto flex-row-reverse" : "mr-auto")}
    >
      <div className={cn("w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center mt-1", m.sender === 'user' ? "bg-blue-600 shadow-lg shadow-blue-900/30" : "bg-slate-800")}>
        {m.sender === 'user' ? <User className="w-4 h-4" /> : m.sender === 'assistant' ? <Bot className="w-4 h-4 text-blue-400" /> : <Terminal className="w-4 h-4" />}
      </div>
      <div className="flex flex-col gap-1.5">
        {m.isTranscript && (
          <div className="flex items-center gap-1.5 mb-0.5 justify-end">
            <Mic className="w-3 h-3 text-emerald-400" />
            <span className="text-[10px] text-emerald-400 uppercase tracking-wider font-bold">Voice Transcript</span>
          </div>
        )}
        {m.isQueued && (
          <div className="flex items-center gap-1.5 mb-0.5 justify-end">
            <span className="text-[10px] text-amber-300 uppercase tracking-wider font-bold">Queued</span>
          </div>
        )}
        {m.sender === 'user' && m.replyToMessageId && m.replyToPreview && (
          <div className="mb-1.5 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 max-w-full">
            <Reply className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
            <span className="text-[10px] text-slate-400 truncate flex-1">{m.replyToPreview.slice(0, 60)}{m.replyToPreview.length > 60 ? '…' : ''}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 font-medium">Reply</span>
          </div>
        )}
        {m.sender === 'assistant' && hasStreamActivity && (
          <ToolCallsScrollContainer isStreaming={false} eventCount={timelineEvents.length} maxHeight="200px">
            <ActivityStream events={timelineEvents} />
          </ToolCallsScrollContainer>
        )}
        {m.sender === 'assistant' && diffEvent && (() => {
          const dp = diffEvent.payload as Record<string, unknown>;
          return (
            <DiffViewer
              diff={dp.diff as string}
              filesChanged={(dp.files_changed as string[]) || []}
              worktreeId={dp.worktree_id as string}
              onApply={async (wtId) => {
                try {
                  await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/apply`, { worktree_id: wtId });
                  toast({ title: "Changes Applied", description: `Worktree ${wtId} merged to working tree` });
                } catch (e: unknown) {
                  toast({ title: "Apply Failed", description: getErrorMessage(e), variant: "destructive" });
                }
              }}
              onDiscard={async (wtId) => {
                try {
                  await axios.delete(`${OASIS_BASE_URL}/api/v1/dev-agent/worktree/${wtId}`);
                  toast({ title: "Changes Discarded", description: `Worktree ${wtId} removed` });
                } catch (e: unknown) {
                  toast({ title: "Discard Failed", description: getErrorMessage(e), variant: "destructive" });
                }
              }}
            />
          );
        })()}
        <div className="flex flex-col gap-1">
          <div className={cn(
            "p-4 rounded-2xl text-sm leading-relaxed shadow-sm",
            m.sender === 'user' ? "bg-blue-600 text-white rounded-tr-none" : "bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-none",
            m.sender === 'system' && "bg-slate-950 border-none italic text-slate-400 py-2 px-0",
            m.sender === 'assistant' && "max-h-72 overflow-y-auto"
          )}>
            {m.sender === 'assistant' ? (
              <MarkdownMessage text={m.text} onOptionClick={onOptionClick} />
            ) : (
              <UserMessageText text={m.text} />
            )}
          </div>
          {m.sender === 'user' && (
            <div className={cn("flex gap-2 text-[10px] text-slate-500 mt-0.5", "justify-end")}>
              <button type="button" className="hover:text-slate-300 underline underline-offset-2" onClick={() => { onEditResend(m.text); inputRef.current?.focus(); }}>Edit &amp; resend</button>
              <span className="text-slate-700">·</span>
              <button type="button" className="hover:text-slate-300 underline underline-offset-2" onClick={() => { void onResend(m.text); }}>Resend</button>
            </div>
          )}
          {m.sender === 'assistant' && (
            <div className="flex gap-2 text-[10px] text-slate-500 mt-0.5">
              <button type="button" className="hover:text-blue-400 flex items-center gap-1 underline underline-offset-2" onClick={() => { onReply(timelineClientKeyForMessage(m), m.text); inputRef.current?.focus(); }}>
                <Reply className="w-3 h-3" />
                Reply
              </button>
            </div>
          )}
        </div>
        {m.sender === 'assistant' && timelineEvents.length > 0 && (
          <ThinkingCard events={timelineEvents} onViewTimeline={() => onViewTimeline(timelineClientKeyForMessage(m))} />
        )}
      </div>
    </motion.div>
  );
}

/** Renders user message text with inline mention chips. */
function UserMessageText({ text }: { text: string }) {
  const segments = parseMessageMentions(text);
  // If no mentions found, render plain text
  if (segments.length === 1 && segments[0].type === 'text') {
    return <>{text}</>;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'mention' ? (
          <span
            key={i}
            className="inline-flex items-center gap-1 bg-blue-500/20 text-blue-300 rounded px-1.5 py-0.5 text-xs font-medium mx-0.5 align-baseline"
          >
            <FileText className="w-3 h-3 flex-shrink-0" />
            @{seg.artifactName}
          </span>
        ) : (
          <span key={i}>{seg.content}</span>
        ),
      )}
    </>
  );
}

