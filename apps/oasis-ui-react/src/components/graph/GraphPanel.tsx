import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, GitFork, Scale, Maximize2, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { GraphPanelProps } from '@/lib/types';
import { KnowledgeGraphViz } from './KnowledgeGraphViz';
import { LogicEngineViz } from './LogicEngineViz';
import { CodeGraphViz } from './CodeGraphViz';

export function GraphPanel({
  graphsBySessionId,
  currentSessionId,
  memoryRules,
  rulesGraph,
  messages,
  onClose,
  onDeleteRule,
  onRefreshRules,
  rulesStorageBackend,
  codeGraph,
  onLoadCodeGraph,
}: GraphPanelProps & { onDeleteRule?: (ruleId: string) => void }) {
  const [activeTab, setActiveTab] = useState<'knowledge' | 'code' | 'logic'>('knowledge');
  const codeGraphLoadedRef = useRef(false);
  const [isGraphExpanded, setIsGraphExpanded] = useState(false);
  const selectedEntry = graphsBySessionId[currentSessionId] ?? null;
  const selectedGraph = selectedEntry?.graph;
  const nodes = (selectedGraph?.nodes as Array<{ id: string; node_type?: string; title?: string }>) || [];
  const edges = (selectedGraph?.edges as Array<{ source_node: string; target_node: string; edge_type?: string }>) || [];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsGraphExpanded(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Refetch rules when user opens the Logic tab (fixes empty list after API hiccup or stale state).
  useEffect(() => {
    if (activeTab === 'logic') onRefreshRules?.();
  }, [activeTab, onRefreshRules]);

  // Lazy-load code graph on first visit to the tab.
  useEffect(() => {
    if (activeTab === 'code' && !codeGraphLoadedRef.current) {
      codeGraphLoadedRef.current = true;
      onLoadCodeGraph?.();
    }
  }, [activeTab, onLoadCodeGraph]);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 400, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="h-full min-h-0 border-r border-slate-800 bg-[#0a0f1a] overflow-hidden flex flex-col shrink-0"
    >
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">Reasoning</h2>
        <Button variant="ghost" size="sm" className="text-slate-500 hover:text-white" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'knowledge' | 'code' | 'logic')} className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="px-3 pt-2 flex-shrink-0">
          <TabsList className="w-full grid grid-cols-3 bg-slate-900/80">
            <TabsTrigger value="knowledge" className="text-xs flex items-center gap-1.5"><GitFork className="w-3.5 h-3.5" /> Knowledge</TabsTrigger>
            <TabsTrigger value="code" className="text-xs flex items-center gap-1.5"><Code2 className="w-3.5 h-3.5" /> Code graph</TabsTrigger>
            <TabsTrigger value="logic" className="text-xs flex items-center gap-1.5"><Scale className="w-3.5 h-3.5" /> Logic</TabsTrigger>
          </TabsList>
        </div>
        {/* One ScrollArea per tab: wrapping both TabsContent in a single ScrollArea breaks Radix tab height / visibility. */}
        <TabsContent value="knowledge" className="flex-1 flex flex-col min-h-0 mt-0 overflow-hidden data-[state=inactive]:hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-500">Graph for current thread ({nodes.length} nodes)</span>
                {nodes.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-slate-500 hover:text-white h-7 px-2"
                    onClick={() => setIsGraphExpanded(true)}
                    title="Expand graph"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
              <KnowledgeGraphViz
                nodes={nodes}
                edges={edges}
                hasGraphEntries={!!selectedEntry}
                hasSelection={!!selectedEntry}
              />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="code" className="flex-1 flex flex-col min-h-0 mt-0 overflow-hidden data-[state=inactive]:hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3 space-y-2">
              {codeGraph?.stats && (
                <span className="text-[11px] font-medium text-slate-500">
                  {codeGraph.stats.files} files &middot; {codeGraph.stats.symbols} symbols
                </span>
              )}
              {codeGraph === undefined && (
                <p className="text-[11px] text-slate-500 py-6 text-center">
                  Code graph unavailable &mdash; start the code-indexer service.
                </p>
              )}
              {codeGraph === null && (
                <p className="text-[11px] text-slate-500 py-6 text-center">Loading code graph&hellip;</p>
              )}
              {codeGraph && <CodeGraphViz data={codeGraph} />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="logic" className="flex-1 flex flex-col min-h-0 mt-0 overflow-hidden data-[state=inactive]:hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3">
              <LogicEngineViz
                memoryRules={memoryRules}
                rulesGraph={rulesGraph}
                selectedData={selectedEntry ?? null}
                onDeleteRule={onDeleteRule}
                rulesStorageBackend={rulesStorageBackend}
              />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {isGraphExpanded && nodes.length > 0 && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setIsGraphExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Knowledge graph expanded view"
        >
          <div
            className="bg-[#0a0f1a] rounded-lg border border-slate-800 shadow-xl overflow-hidden flex flex-col"
            style={{ width: '90vw', maxWidth: 1200, height: '80vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-300">Knowledge Graph (expanded)</h3>
              <Button variant="ghost" size="sm" className="text-slate-500 hover:text-white" onClick={() => setIsGraphExpanded(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4 min-h-0">
              <KnowledgeGraphViz
                nodes={nodes}
                edges={edges}
                hasGraphEntries={!!selectedEntry}
                hasSelection={!!selectedEntry}
                containerWidth={800}
                containerHeight={550}
              />
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
