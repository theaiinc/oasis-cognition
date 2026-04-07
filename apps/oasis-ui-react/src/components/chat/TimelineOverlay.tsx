import { useRef, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import type { TimelineEvent } from '@/lib/types';
import { PlanCard, ToolCallsDisplay, ThoughtsDisplay } from '@/components/timeline';

interface TimelineOverlayProps {
  sessionId: string;
  events: TimelineEvent[];
  onClose: () => void;
}

/** Max JSON chars to show before truncating with "Show more" */
const MAX_PAYLOAD_CHARS = 300;

function PayloadPreview({ payload }: { payload: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const json = useMemo(() => JSON.stringify(payload, null, 2), [payload]);

  if (!payload || Object.keys(payload).length === 0) return null;
  const needsTrunc = json.length > MAX_PAYLOAD_CHARS;
  const display = expanded || !needsTrunc ? json : json.slice(0, MAX_PAYLOAD_CHARS) + '\n...';

  return (
    <>
      <pre className="mt-2 text-[11px] leading-relaxed text-slate-400 whitespace-pre-wrap break-words">
        {display}
      </pre>
      {needsTrunc && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          className="mt-0.5 text-[10px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
        >
          {expanded ? 'Collapse' : 'Expand full payload'}
        </button>
      )}
    </>
  );
}

const NOISE_EVENTS = new Set([
  'ThoughtChunkGenerated',
  'ResponseChunkGenerated',
  'ToolReasoningChunkGenerated',
]);

export function TimelineOverlay({ sessionId, events, onClose }: TimelineOverlayProps) {
  const filteredEvents = useMemo(
    () => events.filter(e => !NOISE_EVENTS.has(e.event_type)),
    [events],
  );

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: filteredEvents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 10,
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 12, opacity: 0 }}
        className="w-full max-w-2xl max-h-[90vh] rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
          <div className="flex flex-col">
            <div className="text-sm font-semibold text-slate-200">Reasoning timeline</div>
            <div className="text-xs text-slate-500">Session: {sessionId} &middot; {filteredEvents.length} events</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {/* Summary cards — scrollable with max height so they don't push event log off screen */}
        <div className="p-5 pb-2 space-y-4 border-b border-slate-800/40 max-h-[40vh] overflow-y-auto flex-shrink-0">
          <PlanCard events={events} />
          <ThoughtsDisplay events={events} />
          <ToolCallsDisplay events={events} />
        </div>

        {/* Event log — virtualized */}
        <div className="px-5 pt-3 pb-1 flex-shrink-0">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Event Log ({filteredEvents.length})
          </div>
        </div>

        <div
          ref={parentRef}
          className="flex-1 overflow-y-auto px-5 pb-5"
        >
          {filteredEvents.length === 0 ? (
            <div className="text-sm text-slate-400 py-4">
              No timeline events captured for this message yet.
            </div>
          ) : (
            <div
              style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
            >
              {virtualizer.getVirtualItems().map(virtualRow => {
                const e = filteredEvents[virtualRow.index];
                return (
                  <div
                    key={e.event_id || virtualRow.index}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className="py-1.5"
                  >
                    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="text-sm font-semibold text-slate-200">{e.event_type}</div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          {new Date(e.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                      {e.payload && Object.keys(e.payload).length > 0 && (
                        <PayloadPreview payload={e.payload as Record<string, unknown>} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
