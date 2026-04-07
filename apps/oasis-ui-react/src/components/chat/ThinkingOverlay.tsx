import { useMemo } from 'react';
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
}

export function ThinkingOverlay({
  isThinking,
  activeClientMessageId,
  timelineByClientMessageId,
  messages,
  onViewTimeline,
  onStop,
}: ThinkingOverlayProps) {
  const liveEvents = activeClientMessageId ? (timelineByClientMessageId[activeClientMessageId] || []) : [];
  const hasPlan = liveEvents.some(e => e.event_type === 'ToolPlanReady');
  const hasToolUse = liveEvents.some(e => e.event_type === 'ToolCallStarted');
  const hasThoughts = liveEvents.some(e =>
    e.event_type === 'ThoughtsValidated' ||
    e.event_type === 'ThoughtChunkGenerated' ||
    e.event_type === 'ThoughtLayerGenerated'
  );

  /** Thought stream / layer text changes → scroll activity wrapper; duplicate layer payloads do not bump. */
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
        {(hasPlan || hasToolUse || hasThoughts) && (
          <div className="ml-11 max-w-md flex flex-col gap-2">
            {hasPlan && (
              <div className="shrink-0">
                <PlanCard events={liveEvents} />
              </div>
            )}
            {(hasThoughts || hasToolUse) && (
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
