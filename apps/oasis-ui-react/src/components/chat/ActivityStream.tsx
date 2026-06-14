import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TruncatedOutput } from '@/components/ui/truncated-output';
import {
  Loader2,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  GitBranch,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { TimelineEvent } from '@/lib/types';

/**
 * ActivityStream: renders only tool call events from the timeline.
 *
 * Thought events (ThoughtLayerGenerated, ThoughtChunkGenerated, ThoughtsValidated)
 * are not rendered here — they are displayed in ThinkingCard → ThoughtsDisplay
 * (post-message) and in ThinkingOverlay (live display).
 */
function timelinePayloadIid(
  payload: Record<string, unknown> | undefined,
): string {
  return (
    (payload?.interaction_id as string) ||
    (payload?.client_message_id as string) ||
    'initial'
  );
}

/**
 * Build timeline segments — now only handles tool events.
 */
function buildTimelineSegments(
  streamEvents: TimelineEvent[],
): Array<{ kind: 'tool'; index: number }> {
  const out: Array<{ kind: 'tool'; index: number }> = [];
  for (let i = 0; i < streamEvents.length; i++) {
    const e = streamEvents[i];
    if (e.event_type === 'ToolCallStarted') {
      out.push({ kind: 'tool', index: i });
    }
  }
  return out;
}

interface ActivityStreamProps {
  events: TimelineEvent[];
}

/** Threshold above which we virtualize the segment list */
const VIRTUALIZE_THRESHOLD = 15;

export function ActivityStream({ events }: ActivityStreamProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const virtualParentRef = useRef<HTMLDivElement>(null);

  const streamEvents = events.filter(
    e =>
      e.event_type === 'ToolCallStarted',
  );
  const completions = events.filter(e => e.event_type === 'ToolCallCompleted');
  const blocks = events.filter(e => e.event_type === 'ToolCallBlocked');

  if (streamEvents.length === 0) return null;

  const segments = buildTimelineSegments(streamEvents);
  const useVirtual = segments.length > VIRTUALIZE_THRESHOLD;

  // Virtual scrolling for large segment lists
  if (useVirtual) {
    return (
      <VirtualizedToolSegments
        segments={segments}
        streamEvents={streamEvents}
        completions={completions}
        blocks={blocks}
        expandedIdx={expandedIdx}
        setExpandedIdx={setExpandedIdx}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      {segments.map(seg => {
        const event = streamEvents[seg.index];
        const eventIdx = seg.index;
        const payload = event.payload as Record<string, unknown>;
        const tool = (payload.tool as string) || 'bash';
        const command =
          (payload.command as string) ||
          (tool === 'grep'
            ? `grep "${payload.pattern || ''}" ${(payload.path as string) || '/workspace'}`
            : '') ||
          (payload.path as string) ||
          (payload.url as string) ||
          '';
        const reasoning = (payload.reasoning as string) || '';
        const iteration = (payload.iteration as number) || eventIdx;
        const worktreeId = (payload.worktree_id as string) || '';

        const completion = completions.find(
          ev => (ev.payload as Record<string, unknown>).iteration === iteration,
        );
        const blocked = blocks.some(
          ev => (ev.payload as Record<string, unknown>).iteration === iteration,
        );
        const completionPayload = completion?.payload as
          | Record<string, unknown>
          | undefined;
        const output = (completionPayload?.output as string) || '';
        const success = completionPayload?.success as boolean;
        const isRunning = !completion && !blocked;
        const isExpanded = expandedIdx === eventIdx;

        return (
          <motion.div
            key={`tool-${eventIdx}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-slate-700/60 bg-slate-900/80 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setExpandedIdx(isExpanded ? null : eventIdx)}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/50 transition-colors"
            >
              {isRunning ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                >
                  <Loader2 className="w-4 h-4 text-blue-400 flex-shrink-0" />
                </motion.div>
              ) : blocked ? (
                <ShieldAlert className="w-4 h-4 text-red-400 flex-shrink-0" />
              ) : success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              )}

              <Terminal className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
              <span className="text-xs font-mono text-slate-300 truncate flex-1 text-left">
                {command}
              </span>
              {worktreeId && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-purple-800 text-purple-300 py-0 shrink-0"
                >
                  <GitBranch className="w-2.5 h-2.5 mr-0.5 inline" />
                  {worktreeId}
                </Badge>
              )}
              {blocked && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-red-800 text-red-400 py-0"
                >
                  BLOCKED
                </Badge>
              )}
              {isRunning && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-blue-800 text-blue-400 py-0"
                >
                  RUNNING
                </Badge>
              )}
              {output &&
                (isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                ))}
            </button>

            {reasoning && (
              <div className="px-3 pb-1.5 -mt-0.5">
                <span className="text-[11px] text-slate-500 italic">
                  {reasoning}
                </span>
              </div>
            )}

            <AnimatePresence>
              {isExpanded && output && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-slate-800 bg-slate-950 px-3 py-2 max-h-64 overflow-y-auto">
                    <TruncatedOutput text={output} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Virtualized variant for large tool-call lists ────────────────────────────

type SegmentType = ReturnType<typeof buildTimelineSegments>[number];

interface VirtualizedToolSegmentsProps {
  segments: SegmentType[];
  streamEvents: TimelineEvent[];
  completions: TimelineEvent[];
  blocks: TimelineEvent[];
  expandedIdx: number | null;
  setExpandedIdx: (idx: number | null) => void;
}

function VirtualizedToolSegments({
  segments,
  streamEvents,
  completions,
  blocks,
  expandedIdx,
  setExpandedIdx,
}: VirtualizedToolSegmentsProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      className="flex flex-col w-full overflow-y-auto"
      style={{ maxHeight: '60vh' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => {
          const seg = segments[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div className="pb-2">
                <ToolSegmentItem
                  seg={seg}
                  streamEvents={streamEvents}
                  completions={completions}
                  blocks={blocks}
                  expandedIdx={expandedIdx}
                  setExpandedIdx={setExpandedIdx}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolSegmentItem({
  seg,
  streamEvents,
  completions,
  blocks,
  expandedIdx,
  setExpandedIdx,
}: {
  seg: SegmentType;
  streamEvents: TimelineEvent[];
  completions: TimelineEvent[];
  blocks: TimelineEvent[];
  expandedIdx: number | null;
  setExpandedIdx: (idx: number | null) => void;
}) {
  const event = streamEvents[seg.index];
  const eventIdx = seg.index;
  const payload = event.payload as Record<string, unknown>;
  const tool = (payload.tool as string) || 'bash';
  const command =
    (payload.command as string) ||
    (tool === 'grep'
      ? `grep "${payload.pattern || ''}" ${(payload.path as string) || '/workspace'}`
      : '') ||
    (payload.path as string) ||
    (payload.url as string) ||
    '';
  const reasoning = (payload.reasoning as string) || '';
  const iteration = (payload.iteration as number) || eventIdx;
  const worktreeId = (payload.worktree_id as string) || '';

  const completion = completions.find(
    ev => (ev.payload as Record<string, unknown>).iteration === iteration,
  );
  const blocked = blocks.some(
    ev => (ev.payload as Record<string, unknown>).iteration === iteration,
  );
  const completionPayload = completion?.payload as Record<string, unknown> | undefined;
  const output = (completionPayload?.output as string) || '';
  const success = completionPayload?.success as boolean;
  const isRunning = !completion && !blocked;
  const isExpanded = expandedIdx === eventIdx;

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/80 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpandedIdx(isExpanded ? null : eventIdx)}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/50 transition-colors"
      >
        {isRunning ? (
          <Loader2 className="w-4 h-4 text-blue-400 flex-shrink-0 animate-spin" />
        ) : blocked ? (
          <ShieldAlert className="w-4 h-4 text-red-400 flex-shrink-0" />
        ) : success ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
        )}

        <Terminal className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
        <span className="text-xs font-mono text-slate-300 truncate flex-1 text-left">
          {command}
        </span>
        {worktreeId && (
          <Badge variant="outline" className="text-[10px] border-purple-800 text-purple-300 py-0 shrink-0">
            <GitBranch className="w-2.5 h-2.5 mr-0.5 inline" />
            {worktreeId}
          </Badge>
        )}
        {blocked && (
          <Badge variant="outline" className="text-[10px] border-red-800 text-red-400 py-0">BLOCKED</Badge>
        )}
        {isRunning && (
          <Badge variant="outline" className="text-[10px] border-blue-800 text-blue-400 py-0">RUNNING</Badge>
        )}
        {output && (isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />)}
      </button>

      {reasoning && (
        <div className="px-3 pb-1.5 -mt-0.5">
          <span className="text-[11px] text-slate-500 italic">{reasoning}</span>
        </div>
      )}

      {isExpanded && output && (
        <div className="border-t border-slate-800 bg-slate-950 px-3 py-2 max-h-64 overflow-y-auto">
          <TruncatedOutput text={output} />
        </div>
      )}
    </div>
  );
}
