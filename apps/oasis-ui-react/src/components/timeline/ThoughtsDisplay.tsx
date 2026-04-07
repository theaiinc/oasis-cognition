import { useState } from 'react';
import { Lightbulb, ChevronDown, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TimelineEvent } from '@/lib/types';
import { motion } from 'framer-motion';

/** Strip smart/curly quotes — LLMs emit them and they look distracting. */
function cleanThoughtText(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
}

function ThoughtMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`text-[11px] font-medium leading-relaxed break-words min-w-0 thought-markdown ${className || ''}`}>
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
          pre: ({ children }) => <pre className="bg-amber-950/30 rounded p-1.5 my-1 text-[10px] font-mono overflow-x-auto">{children}</pre>,
        }}
      >
        {cleanThoughtText(text)}
      </ReactMarkdown>
    </div>
  );
}

interface ThoughtsDisplayProps {
  events: TimelineEvent[];
}

export function ThoughtsDisplay({ events }: ThoughtsDisplayProps) {
  const [validatedExpanded, setValidatedExpanded] = useState<
    Record<string, boolean>
  >({});

  const thoughtEvents = events.filter(
    e =>
      e.event_type === 'ThoughtsValidated' ||
      e.event_type === 'ThoughtLayerGenerated' ||
      e.event_type === 'ThoughtChunkGenerated',
  );

  if (thoughtEvents.length === 0) return null;

  // Group events by interaction_id to aggregate chunks
  const groups: Record<string, TimelineEvent[]> = {};
  const orderedGroups: string[] = [];

  thoughtEvents.forEach(e => {
    const payload = e.payload as Record<string, unknown>;
    const iid =
      (payload.interaction_id as string) ||
      (payload.client_message_id as string) ||
      'initial';
    if (!groups[iid]) {
      groups[iid] = [];
      orderedGroups.push(iid);
    }
    groups[iid].push(e);
  });

  return (
    <div className="flex flex-col gap-2 mt-3">
      <div className="flex items-center gap-1.5">
        <Lightbulb className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-slate-300">
          Agent Thoughts ({orderedGroups.length})
        </span>
      </div>
      {orderedGroups.map(iid => {
        const group = groups[iid];
        const hasFull = group.find(
          e => e.event_type === 'ThoughtLayerGenerated',
        );
        const chunks = group.filter(
          e => e.event_type === 'ThoughtChunkGenerated',
        );
        const validated = group.filter(
          e => e.event_type === 'ThoughtsValidated',
        );

        return (
          <div key={`group-${iid}`} className="flex flex-col gap-2">
            {/* Show Chunks or Full Thought Layer */}
            {(hasFull || chunks.length > 0) && (
              <motion.div
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                className="rounded-lg border border-amber-800/40 bg-amber-900/5 px-3 py-2"
              >
                <ThoughtMarkdown
                  text={
                    hasFull
                      ? (hasFull.payload.thoughts as string)
                      : chunks.map(c => c.payload.chunk as string).join('')
                  }
                  className="text-amber-200/80"
                />
              </motion.div>
            )}

            {/* Show Validated thoughts */}
            {validated.map((v, vidx) => {
              const thoughts =
                (v.payload.thoughts as Array<{
                  thought: string;
                  confidence: number;
                }>) || [];
              const vk = `${iid}-${vidx}`;
              const valExp = validatedExpanded[vk] === true;
              const multi = thoughts.length > 1;
              const visible = !multi || valExp ? thoughts : thoughts.slice(-1);
              return (
                <div
                  key={`validated-${iid}-${vidx}`}
                  className="flex flex-col gap-1.5"
                >
                  {multi && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          setValidatedExpanded(prev => ({
                            ...prev,
                            [vk]: !valExp,
                          }))
                        }
                        className="flex items-center gap-0.5 text-[10px] font-medium text-amber-500/90 hover:text-amber-400 transition-colors"
                      >
                        {valExp ? (
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
                    </div>
                  )}
                  {visible.map((t, tidx) => (
                    <motion.div
                      key={`thought-${iid}-${vidx}-${tidx}`}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="rounded-lg border border-amber-800/60 bg-amber-900/10 px-3 py-2"
                    >
                      <div className="flex items-start gap-2">
                        <ThoughtMarkdown text={t.thought} className="text-amber-200/90 flex-1 min-w-0" />
                        {t.confidence !== undefined && (
                          <div className="ml-auto text-[10px] text-amber-500/60 font-mono whitespace-nowrap mt-0.5">
                            {(Number(t.confidence) * 100).toFixed(0)}%
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
