import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TruncatedOutput } from '@/components/ui/truncated-output';
import {
  Lightbulb,
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
import { cn } from '@/lib/utils';
import type { TimelineEvent } from '@/lib/types';

/** ~3 lines at text-[11px] + leading-relaxed */
const THOUGHT_QUOTE_MAX_COLLAPSED = 'max-h-[3.4rem]';

function thoughtTextNeedsToggle(text: string): boolean {
  return text.length > 72 || text.includes('\n');
}

/** Strip smart/curly quotes from thought text — LLMs emit them and they look distracting. */
function cleanThoughtText(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
}

function ThoughtQuoteBody({
  text,
  lineClamp,
  className,
}: {
  text: string;
  lineClamp: boolean;
  className?: string;
}) {
  const cleaned = cleanThoughtText(text);
  const baseCls =
    'text-[11px] font-medium leading-relaxed break-words min-w-0 thought-markdown';

  const content = (
    <div className={cn(baseCls, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => (
            <code className="bg-amber-950/40 text-amber-100 px-1 py-0.5 rounded text-[10px] font-mono">{children}</code>
          ),
          ul: ({ children }) => <ul className="list-disc list-inside mb-1 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside mb-1 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-amber-300 hover:text-amber-200 underline underline-offset-2">{children}</a>
          ),
          h1: ({ children }) => <p className="font-bold mb-1">{children}</p>,
          h2: ({ children }) => <p className="font-bold mb-1">{children}</p>,
          h3: ({ children }) => <p className="font-semibold mb-1">{children}</p>,
          pre: ({ children }) => <pre className="bg-amber-950/30 rounded p-1.5 my-1 text-[10px] font-mono overflow-x-auto">{children}</pre>,
        }}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );

  // Collapsed: max-height clips overflow; flex-end aligns content to the bottom so the
  // visible window shows the latest lines (not the beginning).
  if (!lineClamp) {
    return content;
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col justify-end overflow-hidden',
        THOUGHT_QUOTE_MAX_COLLAPSED,
      )}
    >
      {content}
    </div>
  );
}

function LayerExpandToggle({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-0.5 shrink-0 text-[10px] font-medium text-amber-500/90 hover:text-amber-400 transition-colors"
    >
      {expanded ? (
        <>
          <ChevronDown className="w-3 h-3" />
          Show less
        </>
      ) : (
        <>
          <ChevronRight className="w-3 h-3" />
          Show full
        </>
      )}
    </button>
  );
}

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
 * Timeline-ordered segments: thought chunks (+ optional following layer) stay where they occur;
 * later tool cards render after them in the stream (no sticky block at the bottom).
 */
function buildTimelineSegments(
  streamEvents: TimelineEvent[],
): Array<
  | { kind: 'thought_layer'; keyIdx: number; iid: string; text: string }
  | { kind: 'thought_validated'; index: number }
  | { kind: 'tool'; index: number }
> {
  const out: Array<
    | { kind: 'thought_layer'; keyIdx: number; iid: string; text: string }
    | { kind: 'thought_validated'; index: number }
    | { kind: 'tool'; index: number }
  > = [];
  let i = 0;
  while (i < streamEvents.length) {
    const e = streamEvents[i];
    if (e.event_type === 'ThoughtChunkGenerated') {
      const iid = timelinePayloadIid(e.payload as Record<string, unknown>);
      let j = i;
      let acc = '';
      while (
        j < streamEvents.length &&
        streamEvents[j].event_type === 'ThoughtChunkGenerated'
      ) {
        const pj = streamEvents[j].payload as Record<string, unknown>;
        if (timelinePayloadIid(pj) !== iid) break;
        acc += String(pj.chunk || '');
        j++;
      }
      let text = acc;
      if (
        j < streamEvents.length &&
        streamEvents[j].event_type === 'ThoughtLayerGenerated' &&
        timelinePayloadIid(
          streamEvents[j].payload as Record<string, unknown>,
        ) === iid
      ) {
        const fp = streamEvents[j].payload as Record<string, unknown>;
        text = String((fp.thoughts as string) || '') || acc;
        j++;
      }
      if (text.trim()) {
        out.push({ kind: 'thought_layer', keyIdx: i, iid, text });
      }
      i = j;
      continue;
    }
    if (e.event_type === 'ThoughtLayerGenerated') {
      const iid = timelinePayloadIid(e.payload as Record<string, unknown>);
      const text = String(
        (e.payload as Record<string, unknown>).thoughts || '',
      );
      if (text.trim()) {
        out.push({ kind: 'thought_layer', keyIdx: i, iid, text });
      }
      i++;
      continue;
    }
    if (e.event_type === 'ThoughtsValidated') {
      out.push({ kind: 'thought_validated', index: i });
      i++;
      continue;
    }
    if (e.event_type === 'ToolCallStarted') {
      out.push({ kind: 'tool', index: i });
      i++;
      continue;
    }
    i++;
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
  const [validatedThoughtsExpanded, setValidatedThoughtsExpanded] = useState<
    Record<number, boolean>
  >({});
  const [thoughtLayerExpanded, setThoughtLayerExpanded] = useState<
    Record<string, boolean>
  >({});
  const [validatedQuoteExpanded, setValidatedQuoteExpanded] = useState<
    Record<string, boolean>
  >({});
  const virtualParentRef = useRef<HTMLDivElement>(null);

  const streamEvents = events.filter(
    e =>
      e.event_type === 'ThoughtsValidated' ||
      e.event_type === 'ToolCallStarted' ||
      e.event_type === 'ThoughtLayerGenerated' ||
      e.event_type === 'ThoughtChunkGenerated',
  );
  const completions = events.filter(e => e.event_type === 'ToolCallCompleted');
  const blocks = events.filter(e => e.event_type === 'ToolCallBlocked');

  if (streamEvents.length === 0) return null;

  const segments = buildTimelineSegments(streamEvents);
  const useVirtual = segments.length > VIRTUALIZE_THRESHOLD;

  // Virtual scrolling for large segment lists
  if (useVirtual) {
    return (
      <VirtualizedActivitySegments
        segments={segments}
        streamEvents={streamEvents}
        completions={completions}
        blocks={blocks}
        expandedIdx={expandedIdx}
        setExpandedIdx={setExpandedIdx}
        validatedThoughtsExpanded={validatedThoughtsExpanded}
        setValidatedThoughtsExpanded={setValidatedThoughtsExpanded}
        thoughtLayerExpanded={thoughtLayerExpanded}
        setThoughtLayerExpanded={setThoughtLayerExpanded}
        validatedQuoteExpanded={validatedQuoteExpanded}
        setValidatedQuoteExpanded={setValidatedQuoteExpanded}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      {segments.map(seg => {
        if (seg.kind === 'thought_layer') {
          const layerKey = `layer-${seg.iid}-${seg.keyIdx}`;
          const layerExpanded = thoughtLayerExpanded[layerKey] === true;
          const needsToggle = thoughtTextNeedsToggle(seg.text);
          return (
            <div
              key={`thought-layer-${seg.keyIdx}`}
              className="flex flex-col gap-1.5 mb-1 mt-1"
            >
              <div className="flex items-center gap-1.5 justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Lightbulb className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="text-xs font-semibold text-slate-300">
                    Free Thoughts
                  </span>
                </div>
                {needsToggle && (
                  <LayerExpandToggle
                    expanded={layerExpanded}
                    onClick={() =>
                      setThoughtLayerExpanded(prev => ({
                        ...prev,
                        [layerKey]: !prev[layerKey],
                      }))
                    }
                  />
                )}
              </div>
              <motion.div
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                className="rounded-lg border border-amber-800/40 bg-amber-900/5 px-3 py-2"
              >
                <ThoughtQuoteBody
                  text={seg.text}
                  lineClamp={needsToggle && !layerExpanded}
                  className="text-amber-200/80"
                />
              </motion.div>
            </div>
          );
        }

        if (seg.kind === 'thought_validated') {
          const event = streamEvents[seg.index];
          const payload = event.payload as Record<string, unknown>;
          const thoughts =
            (payload.thoughts as Array<{
              thought: string;
              confidence: number;
            }>) || [];
          if (thoughts.length === 0) return null;
          const eventIdx = seg.index;
          const valExpanded = validatedThoughtsExpanded[eventIdx] === true;
          const multi = thoughts.length > 1;

          return (
            <div
              key={`thought-${eventIdx}`}
              className="flex flex-col gap-1.5 mb-1 mt-1"
            >
              <div className="flex items-center gap-1.5 justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Lightbulb className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="text-xs font-semibold text-slate-300">
                    Agent Thoughts
                  </span>
                </div>
                {multi && (
                  <button
                    type="button"
                    onClick={() =>
                      setValidatedThoughtsExpanded(prev => ({
                        ...prev,
                        [eventIdx]: !valExpanded,
                      }))
                    }
                    className="flex items-center gap-0.5 shrink-0 text-[10px] font-medium text-amber-500/90 hover:text-amber-400 transition-colors"
                  >
                    {valExpanded ? (
                      <>
                        <ChevronDown className="w-3 h-3" />
                        Show less
                      </>
                    ) : (
                      <>
                        <ChevronRight className="w-3 h-3" />
                        Show all ({thoughts.length})
                      </>
                    )}
                  </button>
                )}
              </div>
              {(!multi || valExpanded
                ? thoughts.map((_, idx) => idx)
                : [thoughts.length - 1]
              ).map(origIdx => {
                const t = thoughts[origIdx];
                const qKey = `${eventIdx}-${origIdx}`;
                const qExp = validatedQuoteExpanded[qKey] === true;
                const needsQuoteToggle = thoughtTextNeedsToggle(t.thought);
                return (
                  <motion.div
                    key={`thought-${eventIdx}-${origIdx}`}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="rounded-lg border border-amber-800/60 bg-amber-900/10 px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <ThoughtQuoteBody
                        text={t.thought}
                        lineClamp={needsQuoteToggle && !qExp}
                        className="text-amber-200/90 flex-1 min-w-0"
                      />
                      {t.confidence !== undefined && (
                        <div className="ml-auto text-[10px] text-amber-500/60 font-mono whitespace-nowrap mt-0.5 shrink-0">
                          {(t.confidence * 100).toFixed(0)}%
                        </div>
                      )}
                    </div>
                    {needsQuoteToggle && (
                      <div className="mt-1 flex justify-end">
                        <LayerExpandToggle
                          expanded={qExp}
                          onClick={() =>
                            setValidatedQuoteExpanded(prev => ({
                              ...prev,
                              [qKey]: !prev[qKey],
                            }))
                          }
                        />
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          );
        }

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

interface VirtualizedActivitySegmentsProps {
  segments: SegmentType[];
  streamEvents: TimelineEvent[];
  completions: TimelineEvent[];
  blocks: TimelineEvent[];
  expandedIdx: number | null;
  setExpandedIdx: (idx: number | null) => void;
  validatedThoughtsExpanded: Record<number, boolean>;
  setValidatedThoughtsExpanded: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  thoughtLayerExpanded: Record<string, boolean>;
  setThoughtLayerExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  validatedQuoteExpanded: Record<string, boolean>;
  setValidatedQuoteExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

function VirtualizedActivitySegments({
  segments,
  streamEvents,
  completions,
  blocks,
  expandedIdx,
  setExpandedIdx,
  validatedThoughtsExpanded,
  setValidatedThoughtsExpanded,
  thoughtLayerExpanded,
  setThoughtLayerExpanded,
  validatedQuoteExpanded,
  setValidatedQuoteExpanded,
}: VirtualizedActivitySegmentsProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const seg = segments[index];
      if (seg.kind === 'thought_layer' || seg.kind === 'thought_validated') return 72;
      return 48; // tool card collapsed
    },
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
                <ActivitySegmentItem
                  seg={seg}
                  streamEvents={streamEvents}
                  completions={completions}
                  blocks={blocks}
                  expandedIdx={expandedIdx}
                  setExpandedIdx={setExpandedIdx}
                  validatedThoughtsExpanded={validatedThoughtsExpanded}
                  setValidatedThoughtsExpanded={setValidatedThoughtsExpanded}
                  thoughtLayerExpanded={thoughtLayerExpanded}
                  setThoughtLayerExpanded={setThoughtLayerExpanded}
                  validatedQuoteExpanded={validatedQuoteExpanded}
                  setValidatedQuoteExpanded={setValidatedQuoteExpanded}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Renders a single segment — extracted so both regular and virtualized paths use the same logic. */
function ActivitySegmentItem({
  seg,
  streamEvents,
  completions,
  blocks,
  expandedIdx,
  setExpandedIdx,
  validatedThoughtsExpanded,
  setValidatedThoughtsExpanded,
  thoughtLayerExpanded,
  setThoughtLayerExpanded,
  validatedQuoteExpanded,
  setValidatedQuoteExpanded,
}: {
  seg: SegmentType;
  streamEvents: TimelineEvent[];
  completions: TimelineEvent[];
  blocks: TimelineEvent[];
  expandedIdx: number | null;
  setExpandedIdx: (idx: number | null) => void;
  validatedThoughtsExpanded: Record<number, boolean>;
  setValidatedThoughtsExpanded: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  thoughtLayerExpanded: Record<string, boolean>;
  setThoughtLayerExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  validatedQuoteExpanded: Record<string, boolean>;
  setValidatedQuoteExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) {
  if (seg.kind === 'thought_layer') {
    const layerKey = `layer-${seg.iid}-${seg.keyIdx}`;
    const layerExpanded = thoughtLayerExpanded[layerKey] === true;
    const needsToggle = thoughtTextNeedsToggle(seg.text);
    return (
      <div className="flex flex-col gap-1.5 mb-1 mt-1">
        <div className="flex items-center gap-1.5 justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <Lightbulb className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-300">Free Thoughts</span>
          </div>
          {needsToggle && (
            <LayerExpandToggle
              expanded={layerExpanded}
              onClick={() =>
                setThoughtLayerExpanded(prev => ({ ...prev, [layerKey]: !prev[layerKey] }))
              }
            />
          )}
        </div>
        <div className="rounded-lg border border-amber-800/40 bg-amber-900/5 px-3 py-2">
          <ThoughtQuoteBody
            text={seg.text}
            lineClamp={needsToggle && !layerExpanded}
            className="text-amber-200/80"
          />
        </div>
      </div>
    );
  }

  if (seg.kind === 'thought_validated') {
    const event = streamEvents[seg.index];
    const payload = event.payload as Record<string, unknown>;
    const thoughts = (payload.thoughts as Array<{ thought: string; confidence: number }>) || [];
    if (thoughts.length === 0) return null;
    const eventIdx = seg.index;
    const valExpanded = validatedThoughtsExpanded[eventIdx] === true;
    const multi = thoughts.length > 1;

    return (
      <div className="flex flex-col gap-1.5 mb-1 mt-1">
        <div className="flex items-center gap-1.5 justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <Lightbulb className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-300">Agent Thoughts</span>
          </div>
          {multi && (
            <button
              type="button"
              onClick={() =>
                setValidatedThoughtsExpanded(prev => ({ ...prev, [eventIdx]: !valExpanded }))
              }
              className="flex items-center gap-0.5 shrink-0 text-[10px] font-medium text-amber-500/90 hover:text-amber-400 transition-colors"
            >
              {valExpanded ? (
                <><ChevronDown className="w-3 h-3" />Show less</>
              ) : (
                <><ChevronRight className="w-3 h-3" />Show all ({thoughts.length})</>
              )}
            </button>
          )}
        </div>
        {(!multi || valExpanded ? thoughts.map((_, idx) => idx) : [thoughts.length - 1]).map(origIdx => {
          const t = thoughts[origIdx];
          const qKey = `${eventIdx}-${origIdx}`;
          const qExp = validatedQuoteExpanded[qKey] === true;
          const needsQuoteToggle = thoughtTextNeedsToggle(t.thought);
          return (
            <div
              key={`thought-${eventIdx}-${origIdx}`}
              className="rounded-lg border border-amber-800/60 bg-amber-900/10 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <ThoughtQuoteBody
                  text={t.thought}
                  lineClamp={needsQuoteToggle && !qExp}
                  className="text-amber-200/90 flex-1 min-w-0"
                />
                {t.confidence !== undefined && (
                  <div className="ml-auto text-[10px] text-amber-500/60 font-mono whitespace-nowrap mt-0.5 shrink-0">
                    {(t.confidence * 100).toFixed(0)}%
                  </div>
                )}
              </div>
              {needsQuoteToggle && (
                <div className="mt-1 flex justify-end">
                  <LayerExpandToggle
                    expanded={qExp}
                    onClick={() =>
                      setValidatedQuoteExpanded(prev => ({ ...prev, [qKey]: !prev[qKey] }))
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Tool card
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
