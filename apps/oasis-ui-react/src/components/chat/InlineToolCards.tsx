import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Terminal, CheckCircle2, AlertTriangle, ShieldAlert,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TruncatedOutput } from '@/components/ui/truncated-output';
import type { TimelineEvent } from '@/lib/types';

interface InlineToolCardsProps {
  events: TimelineEvent[];
}

export function InlineToolCards({ events }: InlineToolCardsProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const starts = events.filter(e => e.event_type === 'ToolCallStarted');
  const completions = events.filter(e => e.event_type === 'ToolCallCompleted');
  const blocks = events.filter(e => e.event_type === 'ToolCallBlocked');

  if (starts.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 w-full">
      {starts.map((start, idx) => {
        const payload = start.payload as Record<string, unknown>;
        const tool = payload.tool as string || 'bash';
        const command = payload.command as string || (tool === 'grep' ? `grep "${payload.pattern || ''}" ${(payload.path as string) || '/workspace'}` : '') || payload.path as string || payload.url as string || '';
        const reasoning = payload.reasoning as string || '';
        const iteration = payload.iteration as number || idx + 1;

        const completion = completions.find(e =>
          (e.payload as Record<string, unknown>).iteration === iteration
        );
        const blocked = blocks.some(e =>
          (e.payload as Record<string, unknown>).iteration === iteration
        );
        const completionPayload = completion?.payload as Record<string, unknown> | undefined;
        const output = completionPayload?.output as string || '';
        const success = completionPayload?.success as boolean;
        const isRunning = !completion && !blocked;
        const isExpanded = expandedIdx === idx;

        return (
          <motion.div
            key={`tool-${idx}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-slate-700/60 bg-slate-900/80 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/50 transition-colors"
            >
              {isRunning ? (
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
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
              <span className="text-xs font-mono text-slate-300 truncate flex-1 text-left">{command}</span>
              {blocked && <Badge variant="outline" className="text-[10px] border-red-800 text-red-400 py-0">BLOCKED</Badge>}
              {isRunning && <Badge variant="outline" className="text-[10px] border-blue-800 text-blue-400 py-0">RUNNING</Badge>}
              {output && (
                isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
              )}
            </button>

            {reasoning && (
              <div className="px-3 pb-1.5 -mt-0.5">
                <span className="text-[11px] text-slate-500 italic">{reasoning}</span>
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
