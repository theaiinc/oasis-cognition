import { DollarSign, Coins, Infinity as InfinityIcon, AlertCircle, Box } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface JobBudgetInfo {
  job_id: string;
  max_usd: number;
  current_usd: number;
  pct: number;
  task_count: number;
  completed_count: number;
}

interface Props {
  budget: JobBudgetInfo | null;
  onClick?: () => void;
}

/**
 * Compact at-a-glance meter for the current active job's spend.
 * Sits next to the SessionBudgetPill in the chat header when a job is running.
 */
export function JobBudgetPill({ budget, onClick }: Props) {
  if (!budget) return null;

  const { max_usd, current_usd, pct, task_count, completed_count } = budget;
  const isOver = pct >= 1.0;
  const isWarn = pct >= 0.8 && !isOver;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Job budget: $${current_usd.toFixed(4)} / $${max_usd.toFixed(2)} (${(pct * 100).toFixed(0)}%) — ${completed_count}/${task_count} tasks completed`}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
        isOver ? 'bg-red-950/40 border-red-800/50 text-red-300' :
        isWarn ? 'bg-amber-950/30 border-amber-800/40 text-amber-300' :
        'bg-slate-900/60 border-slate-700/50 text-slate-300 hover:text-slate-200',
      )}
    >
      <Box className="w-3.5 h-3.5" />
      <span>${current_usd.toFixed(2)}</span>
      {isOver ? (
        <AlertCircle className="w-3 h-3 text-red-400" />
      ) : (
        <span className="text-[10px] text-slate-500">
          {completed_count}/{task_count}
        </span>
      )}
    </button>
  );
}
