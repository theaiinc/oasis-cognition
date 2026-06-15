import { useMemo, useState, useEffect, useRef } from 'react';
import { PipelineProgress, PlanCard } from '@/components/timeline';
import { ActivityStream } from './ActivityStream';
import { ToolCallsScrollContainer } from './ToolCallsScrollContainer';
import { StreamingCard } from './StreamingCard';
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
  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (isThinking) {
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
      return () => clearInterval(timer);
    }
  }, [isThinking]);

  /** Thought stream / layer text changes — used for activity auto-scroll */
  const thoughtChunkRevision = useMemo(
    () => computeThoughtStreamRevision(liveEvents),
    [liveEvents],
  );

  if (!isThinking) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* Pipeline progress header (clickable to open timeline) */}
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
      </div>

      {/* Streaming card for reasoning */}
      <StreamingCard
        variant="thinking"
        content={liveReasoning}
        streaming={isThinking}
        autoScroll
        maxHeight="340px"
        elapsedMs={elapsedMs}
        onStop={onStop}
      >
        {/* Tool calls and activity below the thinking card */}
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
      </StreamingCard>
    </div>
  );
}
