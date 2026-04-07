import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Loader2, CheckCircle2, AlertTriangle, Circle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TimelineEvent } from '@/lib/types';
import {
  COMPLEX_PIPELINE_STAGES,
  CASUAL_PIPELINE_STAGES,
  TEACHING_PIPELINE_STAGES,
  TOOL_PIPELINE_STAGES,
} from '@/lib/constants';

interface PipelineProgressProps {
  events: TimelineEvent[];
}

export function PipelineProgress({ events }: PipelineProgressProps) {
  const seen = new Set(events.map(e => e.event_type));
  const hasFailed = events.some(e => e.event_type === 'PipelineFailed');
  const isComplete = seen.has('ResponseGenerated') || seen.has('MemoryUpdated');

  const semanticEvent = events.find(e => e.event_type === 'SemanticParsed');
  const detectedRoute = (semanticEvent?.payload?.route as string) || '';
  const isToolUse = detectedRoute === 'tool_use' || seen.has('ToolPlanningStarted') || seen.has('ToolCallStarted');
  const isTeaching = detectedRoute === 'teaching' || seen.has('TeachingValidationComplete');
  const isCasual = detectedRoute === 'casual';
  const stages = isToolUse
    ? TOOL_PIPELINE_STAGES
    : isTeaching
      ? TEACHING_PIPELINE_STAGES
      : isCasual
        ? CASUAL_PIPELINE_STAGES
        : COMPLEX_PIPELINE_STAGES;

  const activeIdx = stages.findIndex(s => !seen.has(s.key));

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeRef.current && scrollContainerRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeIdx]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="flex gap-3"
    >
      <div className="w-7 h-7 rounded-full bg-slate-800 flex-shrink-0 flex items-center justify-center mt-0.5">
        {isComplete ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : hasFailed ? (
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}>
            <Loader2 className="w-3.5 h-3.5 text-blue-400" />
          </motion.div>
        )}
      </div>
      <div className="bg-slate-900 border border-slate-800 px-3 py-2 rounded-2xl rounded-tl-none max-w-[260px] overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="flex items-center gap-1.5 overflow-x-auto scrollbar-none [scrollbar-width:none] [ms-overflow-style:none]"
        >
          {stages.map((stage, idx) => {
            const done = seen.has(stage.key);
            const active = idx === activeIdx && !isComplete && !hasFailed;
            const Icon = stage.icon;
            return (
              <div
                key={stage.key}
                ref={active ? activeRef : undefined}
                className="flex items-center gap-1 flex-shrink-0"
              >
                {done ? (
                  <Icon className="w-3.5 h-3.5 text-emerald-400" />
                ) : active ? (
                  <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.2, repeat: Infinity }}>
                    <Icon className="w-3.5 h-3.5 text-blue-400" />
                  </motion.div>
                ) : (
                  <Circle className="w-3 h-3 text-slate-700" />
                )}
                <span className={cn(
                  "text-[11px] font-medium whitespace-nowrap",
                  done ? "text-emerald-400/80" : active ? "text-blue-400" : "text-slate-600"
                )}>
                  {stage.label}
                </span>
                {idx < stages.length - 1 && (
                  <span className={cn("text-[10px] mx-0.5", done ? "text-emerald-700" : "text-slate-800")}>›</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
