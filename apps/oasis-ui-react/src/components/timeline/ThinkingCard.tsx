import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lightbulb, ChevronDown, ChevronRight, Activity } from 'lucide-react';
import type { TimelineEvent } from '@/lib/types';
import { PlanCard } from './PlanCard';
import { ThoughtsDisplay } from './ThoughtsDisplay';

interface ThinkingCardProps {
  events: TimelineEvent[];
  onViewTimeline: () => void;
}

export function ThinkingCard({ events, onViewTimeline }: ThinkingCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (!events || events.length === 0) return null;

  const semanticEvent = events.find(e => e.event_type === 'SemanticParsed');
  const decisionEvent = events.find(e => e.event_type === 'DecisionFinalized');
  const graphEvent = events.find(e => e.event_type === 'GraphConstructed');
  const toolEvents = events.filter(e => e.event_type === 'ToolCallStarted');
  const toolCompletedEvents = events.filter(e => e.event_type === 'ToolCallCompleted');
  const llmEvents = events.filter(e => e.event_type === 'LlmCallCompleted');
  const pipelineError = events.find(e => e.event_type === 'PipelineFailed');

  const route = (semanticEvent?.payload?.route as string) || '';
  const intent = (semanticEvent?.payload?.intent as string) || '';
  const problem = (semanticEvent?.payload?.problem as string) || '';
  const decision = (decisionEvent?.payload?.decision as string) || '';
  const confidence = decisionEvent?.payload?.confidence as number | undefined;
  const nodeCount = (graphEvent?.payload?.node_count as number) || 0;
  const totalLlmMs = llmEvents.reduce((acc, e) => acc + ((e.payload?.duration_ms as number) || 0), 0);

  const routeLabel = route === 'casual' ? '💬 Casual' :
    route === 'complex' ? '🧠 Deep Reasoning' :
    route === 'teaching' ? '📚 Teaching' :
    route === 'tool_use' ? '🔧 Tool Use' : route;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-slate-800/60 bg-slate-900/30 overflow-hidden mb-1"
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/30 transition-colors"
      >
        <Lightbulb className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
        <span className="text-[11px] text-slate-400 font-medium flex-1 truncate">
          {routeLabel && <span className="text-slate-300 mr-2">{routeLabel}</span>}
          {intent && <span className="text-slate-500">· {intent}</span>}
          {totalLlmMs > 0 && <span className="text-slate-600 ml-2">· {(totalLlmMs / 1000).toFixed(1)}s</span>}
          {toolEvents.length > 0 && <span className="text-blue-400/70 ml-2">· {toolEvents.length} tool call{toolEvents.length !== 1 ? 's' : ''}</span>}
        </span>
        {expanded ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />}
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2 border-t border-slate-800/40 pt-2">
              <PlanCard events={events} />
              <ThoughtsDisplay events={events} />
              {problem && (
                <div className="text-[11px]">
                  <span className="text-slate-500 font-semibold">Problem: </span>
                  <span className="text-slate-300">{problem}</span>
                </div>
              )}
              {nodeCount > 0 && (
                <div className="text-[11px]">
                  <span className="text-slate-500 font-semibold">Reasoning graph: </span>
                  <span className="text-slate-300">{nodeCount} nodes</span>
                </div>
              )}
              {decision && (
                <div className="text-[11px]">
                  <span className="text-slate-500 font-semibold">Conclusion: </span>
                  <span className="text-slate-300">{decision.length > 200 ? decision.slice(0, 200) + '…' : decision}</span>
                  {confidence !== undefined && (
                    <span className="ml-2 text-slate-500">(confidence: {typeof confidence === 'number' ? (confidence * 100).toFixed(0) : confidence}%)</span>
                  )}
                </div>
              )}
              {toolEvents.length > 0 && (
                <div className="text-[11px]">
                  <span className="text-slate-500 font-semibold">Tools used: </span>
                  <span className="text-slate-300">
                    {toolEvents.map((e, i) => {
                      const tool = e.payload?.tool as string;
                      const completed = toolCompletedEvents[i];
                      const success = completed?.payload?.success;
                      const icon = success === false ? '✗' : success === true ? '✓' : '…';
                      return `${tool} ${icon}`;
                    }).join(', ')}
                  </span>
                </div>
              )}
              {pipelineError && (
                <div className="text-[11px] text-red-400">
                  <span className="font-semibold">Error: </span>
                  {(pipelineError.payload?.error as string) || 'Pipeline failed'}
                </div>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onViewTimeline(); }}
                className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1 mt-1"
              >
                <Activity className="w-3 h-3" />
                View full timeline ({events.length} events)
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
