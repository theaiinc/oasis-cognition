import { useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Terminal, ShieldAlert, Wrench } from 'lucide-react';
import type { TimelineEvent } from '@/lib/types';

interface ToolCallsDisplayProps {
  events: TimelineEvent[];
}

/** Threshold above which we virtualize the tool list */
const VIRTUALIZE_THRESHOLD = 20;

export function ToolCallsDisplay({ events }: ToolCallsDisplayProps) {
  const starts = useMemo(
    () => events.filter(e => e.event_type === 'ToolCallStarted'),
    [events],
  );

  if (starts.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mt-3">
      <div className="flex items-center gap-1.5">
        <Wrench className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-xs font-semibold text-slate-300">Tool Calls ({starts.length})</span>
      </div>
      {starts.length > VIRTUALIZE_THRESHOLD ? (
        <VirtualizedToolList starts={starts} events={events} />
      ) : (
        starts.map((start, idx) => (
          <ToolRow key={`tool-${idx}`} start={start} idx={idx} events={events} />
        ))
      )}
    </div>
  );
}

function ToolRow({
  start,
  idx,
  events,
}: {
  start: TimelineEvent;
  idx: number;
  events: TimelineEvent[];
}) {
  const payload = start.payload as Record<string, unknown>;
  const tool = (payload.tool as string) || 'bash';
  const command =
    (payload.command as string) ||
    (payload.path as string) ||
    (payload.url as string) ||
    '';
  const iteration = (payload.iteration as number) || idx + 1;
  const blocked = events.some(
    e =>
      e.event_type === 'ToolCallBlocked' &&
      (e.payload as Record<string, unknown>).iteration === iteration,
  );

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="flex items-center gap-2">
        {blocked ? (
          <ShieldAlert className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
        ) : (
          <Terminal className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
        )}
        <span className="text-[11px] font-mono text-slate-300 truncate">
          {tool}: {command}
        </span>
        {blocked && (
          <span className="text-[10px] text-red-400 font-bold">BLOCKED</span>
        )}
      </div>
    </div>
  );
}

function VirtualizedToolList({
  starts,
  events,
}: {
  starts: TimelineEvent[];
  events: TimelineEvent[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: starts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      className="max-h-60 overflow-y-auto"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.index}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
            className="pb-2"
          >
            <ToolRow
              start={starts[virtualRow.index]}
              idx={virtualRow.index}
              events={events}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
