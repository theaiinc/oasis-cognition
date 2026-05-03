import { motion } from 'framer-motion';
import { MessageSquare, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface HistorySession {
  session_id: string;
  last_active: string;
  preview?: string;
}

interface HistoryPanelProps {
  sessions: HistorySession[];
  currentSessionId: string;
  /** session_ids that are currently mid-interaction — drives the green "working now" pulse. */
  activeSessionIds?: ReadonlySet<string>;
  onNewChat: () => void;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}

export function HistoryPanel({
  sessions,
  currentSessionId,
  activeSessionIds,
  onNewChat,
  onLoadSession,
  onDeleteSession,
}: HistoryPanelProps) {
  const otherActive = sessions.filter(
    (s) => activeSessionIds?.has(s.session_id) && s.session_id !== currentSessionId,
  ).length;
  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 280, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="border-r border-slate-800 bg-[#0a0f1a] overflow-hidden flex flex-col"
    >
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-300">Chat History</h2>
          {otherActive > 0 && (
            <span
              className="flex items-center gap-1 text-[10px] text-emerald-300 bg-emerald-950/40 border border-emerald-800/50 px-1.5 py-0.5 rounded-full"
              title={`${otherActive} other session${otherActive === 1 ? '' : 's'} working in the background`}
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              {otherActive}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-blue-400 hover:text-blue-300"
          onClick={onNewChat}
        >
          + New Chat
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 flex flex-col gap-1">
          {sessions.length === 0 && (
            <p className="text-xs text-slate-500 text-center py-8">
              No conversations yet
            </p>
          )}
          {sessions.map(s => {
            const isActive = activeSessionIds?.has(s.session_id) ?? false;
            return (
              <div
                key={s.session_id}
                className={cn(
                  'group flex items-start gap-2 p-2.5 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors',
                  currentSessionId === s.session_id &&
                    'bg-blue-900/20 border border-blue-800/30',
                )}
                onClick={() => onLoadSession(s.session_id)}
              >
                <div className="relative mt-0.5 flex-shrink-0">
                  <MessageSquare className="w-4 h-4 text-slate-500" />
                  {isActive && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-slate-950 animate-pulse"
                      title="Working now"
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn('text-xs truncate', isActive ? 'text-emerald-200' : 'text-slate-300')}>
                    {s.preview || 'Empty conversation'}
                  </p>
                  <p className="text-[10px] text-slate-600 mt-0.5">
                    {isActive
                      ? <span className="text-emerald-400">Working now</span>
                      : new Date(s.last_active).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-6 h-6 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400"
                  onClick={e => {
                    e.stopPropagation();
                    onDeleteSession(s.session_id);
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </motion.div>
  );
}
