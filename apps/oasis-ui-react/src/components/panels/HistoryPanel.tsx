import { motion } from 'framer-motion';
import { MessageSquare, Trash2 } from 'lucide-react';
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
  onNewChat: () => void;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}

export function HistoryPanel({
  sessions,
  currentSessionId,
  onNewChat,
  onLoadSession,
  onDeleteSession,
}: HistoryPanelProps) {
  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 280, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="border-r border-slate-800 bg-[#0a0f1a] overflow-hidden flex flex-col"
    >
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">Chat History</h2>
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
          {sessions.map(s => (
            <div
              key={s.session_id}
              className={cn(
                'group flex items-start gap-2 p-2.5 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors',
                currentSessionId === s.session_id &&
                  'bg-blue-900/20 border border-blue-800/30',
              )}
              onClick={() => onLoadSession(s.session_id)}
            >
              <MessageSquare className="w-4 h-4 text-slate-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-300 truncate">
                  {s.preview || 'Empty conversation'}
                </p>
                <p className="text-[10px] text-slate-600 mt-0.5">
                  {new Date(s.last_active).toLocaleDateString(undefined, {
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
          ))}
        </div>
      </ScrollArea>
    </motion.div>
  );
}
