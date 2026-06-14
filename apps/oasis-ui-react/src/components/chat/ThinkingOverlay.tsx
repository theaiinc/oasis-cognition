import { useMemo, useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PipelineProgress, PlanCard } from '@/components/timeline';
import { ActivityStream } from './ActivityStream';
import { ToolCallsScrollContainer } from './ToolCallsScrollContainer';
import { Button } from '@/components/ui/button';
import { Square } from 'lucide-react';
import type { TimelineEvent } from '@/lib/types';
import { computeThoughtStreamRevision } from '@/lib/thoughtStreamRevision';
import { timelineClientKeyForMessage } from '@/lib/utils';

interface ThinkingOverlayProps {
  isThinking: boolean;
  activeClientMessageId: string | null;
  timelineByClientMessageId: Record<string, TimelineEvent[]>;
  messages: Array<{ id: string; sender: string }>;
  onViewTimeline: (id: string) => void;
  onStop?: () => void;
  liveReasoning?: string;
}

export function ThinkingOverlay({
  isThinking,
  activeClientMessageId,
  timelineByClientMessageId,
  messages,
  onViewTimeline,
  onStop,
  liveReasoning = '',
}: ThinkingOverlayProps) {
  const liveEvents = activeClientMessageId ? (timelineByClientMessageId[activeClientMessageId] || []) : [];
  const hasPlan = liveEvents.some(e => e.event_type === 'ToolPlanReady');
  const hasToolUse = liveEvents.some(e => e.event_type === 'ToolCallStarted');

  // ── Elapsed time since the current turn started ──────────────────────
  const startedAtRef = useRef<number>(Date.now());
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (isThinking) {
      startedAtRef.current = Date.now();
      setElapsedSec(0);
      const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
      return () => clearInterval(timer);
    }
  }, [isThinking]);

  // ── Auto-scroll reasoning content ────────────────────────────────────
  const reasoningContentRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const SCROLL_THRESHOLD = 60;

  useEffect(() => {
    if (!liveReasoning || userScrolledUp) return;
    const el = reasoningContentRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [liveReasoning, userScrolledUp]);

  useEffect(() => {
    const el = reasoningContentRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (!el) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setUserScrolledUp(distFromBottom > SCROLL_THRESHOLD);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [liveReasoning]);

  /** Thought stream / layer text changes — used for activity auto-scroll */
  const thoughtChunkRevision = useMemo(
    () => computeThoughtStreamRevision(liveEvents),
    [liveEvents],
  );

  if (!isThinking) return null;

  return (
    <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div
            className="cursor-pointer flex-1 min-w-0"
            onClick={() => {
              const lastAssistant = [...messages].reverse().find(m => m.sender === 'assistant');
              const targetId = activeClientMessageId
                || (lastAssistant ? timelineClientKeyForMessage(lastAssistant) : null);
              if (targetId) onViewTimeline(targetId);
            }}
          >
            <PipelineProgress events={liveEvents} />
          </div>
          {onStop && (
            <Button
              variant="ghost"
              size="sm"
              className="flex-shrink-0 h-8 px-2.5 text-red-400 hover:text-red-300 hover:bg-red-950/30"
              onClick={(e) => { e.stopPropagation(); onStop(); }}
              title="Stop pipeline"
              aria-label="Stop pipeline"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span className="ml-1.5 text-[11px] font-medium">Stop</span>
            </Button>
          )}
        </div>
        {liveReasoning ? (
          <div className="ml-2 rounded-lg border border-slate-800/60 bg-slate-900/40 max-h-[340px] overflow-y-auto overscroll-contain"
               ref={reasoningContentRef}>
            {/* Sticky header inside scroll container */}
            <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm border-b border-slate-800/40">
              <div className="flex items-center gap-1.5 px-3 py-2">
                <span className="text-[10px] text-amber-400/80 uppercase tracking-wider font-semibold">
                  Thinking<span className="inline-flex w-4 ml-0.5"><AnimatedDots /></span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">{elapsedSec}s</span>
                <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-amber-400/60 ml-1" />
              </div>
            </div>
            {/* Scrollable markdown content */}
            <div className="px-3 pb-3">
              <div className="text-[11px] text-slate-300 leading-relaxed thought-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                    strong: ({ children }) => <strong className="font-semibold text-slate-100">{children}</strong>,
                    em: ({ children }) => <em className="italic">{children}</em>,
                    code: ({ children }) => (
                      <code className="bg-slate-800 text-emerald-300/80 px-1 py-0.5 rounded text-[10px] font-mono">{children}</code>
                    ),
                    ul: ({ children }) => <ul className="list-disc list-inside mb-1 space-y-0.5">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside mb-1 space-y-0.5">{children}</ol>,
                    li: ({ children }) => <li>{children}</li>,
                    pre: ({ children }) => <pre className="bg-slate-800 rounded p-1.5 my-1 text-[10px] font-mono overflow-x-auto">{children}</pre>,
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{children}</a>
                    ),
                  }}
                >
                  {liveReasoning}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : (
          <div className="ml-2 flex items-center gap-2 px-2 py-1">
            <span className="text-[11px] text-slate-500 font-medium">Working</span>
            <span className="text-[10px] text-slate-600 font-mono">{elapsedSec}s</span>
            <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-blue-400/60" />
          </div>
        )}
        {(hasPlan || hasToolUse) && (
          <div className="ml-11 max-w-md flex flex-col gap-2">
            {hasPlan && (
              <div className="shrink-0">
                <PlanCard events={liveEvents} />
              </div>
            )}
            {hasToolUse && (
              <ToolCallsScrollContainer
                isStreaming={isThinking}
                eventCount={liveEvents.length}
                thoughtChunkRevision={thoughtChunkRevision}
                maxHeight="240px"
              >
                <ActivityStream events={liveEvents} />
              </ToolCallsScrollContainer>
            )}
          </div>
        )}
    </div>
  );
}

/** Animated dots using CSS opacity-stagger animation */
function AnimatedDots() {
  return (
    <span className="inline-flex items-center gap-[1px]">
      <span className="w-1 h-1 rounded-full bg-amber-400/80 animate-bounce [animation-delay:0ms]" />
      <span className="w-1 h-1 rounded-full bg-amber-400/80 animate-bounce [animation-delay:150ms]" />
      <span className="w-1 h-1 rounded-full bg-amber-400/80 animate-bounce [animation-delay:300ms]" />
    </span>
  );
}
