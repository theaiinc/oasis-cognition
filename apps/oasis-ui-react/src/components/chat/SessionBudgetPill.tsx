import { DollarSign, Coins, Infinity as InfinityIcon, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BudgetMode = 'unlimited' | 'tokens' | 'usd';

export interface SessionBudget {
  mode: BudgetMode;
  limit: number;
  warn_at_pct: number;
}

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  usd_estimate: number;
  usd_known: boolean;
  pricing_updated_at: string | null;
  last_model: string | null;
  last_updated: string;
}

interface Props {
  usage: SessionUsage | null;
  budget: SessionBudget | null;
  pct: number;
  /** Open the Settings panel where the cap can be raised. */
  onClick?: () => void;
}

/**
 * Compact at-a-glance meter for the session's running token / USD spend.
 * Sits next to the "Watching N" badge in the chat header.
 *
 * Color rules:
 *   < 80%       → slate (neutral)
 *   80–99%      → amber (warn)
 *   ≥ 100%      → red (refusing further LLM calls)
 *   unlimited   → not rendered at all (no point taking up header space)
 */
export function SessionBudgetPill({ usage, budget, pct, onClick }: Props) {
  if (!usage || !budget) return null;
  const tokensTotal = usage.input_tokens + usage.output_tokens;

  // Unlimited mode: only show the pill if the session has actually used anything,
  // and only as a passive readout (no cap math).
  if (budget.mode === 'unlimited' || budget.limit <= 0) {
    if (tokensTotal === 0) return null;
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:border-slate-500 transition-colors"
        title={
          `Session usage: ${formatTokens(tokensTotal)} tokens${usage.usd_known ? ` (≈ $${usage.usd_estimate.toFixed(4)})` : ''}\n` +
          `No cap set — click to add one.`
        }
      >
        <InfinityIcon className="w-3 h-3" />
        <span className="text-[11px] font-mono">{formatTokens(tokensTotal)}</span>
      </button>
    );
  }

  const warn = pct >= budget.warn_at_pct && pct < 1;
  const over = pct >= 1;
  const color =
    over  ? 'bg-red-950/40    border-red-800/60    text-red-300    hover:border-red-500' :
    warn  ? 'bg-amber-950/40  border-amber-800/60  text-amber-300  hover:border-amber-500' :
            'bg-slate-800/60  border-slate-700/50  text-slate-300  hover:border-slate-500';

  const Icon = budget.mode === 'usd' ? DollarSign : Coins;
  const consumedText = budget.mode === 'usd'
    ? (usage.usd_known ? `$${usage.usd_estimate.toFixed(usage.usd_estimate < 1 ? 4 : 2)}` : '$?')
    : formatTokens(tokensTotal);
  const limitText = budget.mode === 'usd'
    ? `$${budget.limit.toFixed(budget.limit < 1 ? 4 : 2)}`
    : formatTokens(budget.limit);

  const usdNote = budget.mode === 'usd' && !usage.usd_known
    ? '\n⚠ No pricing for the current model — token meter is accurate, $ is unknown.'
    : '';
  const staleNote = budget.mode === 'usd' && usage.usd_known && usage.pricing_updated_at
    ? `\nPricing as of ${usage.pricing_updated_at}.`
    : '';
  const tooltipBase = over
    ? `Budget cap reached — Oasis is refusing further LLM calls in this session. Raise the cap in Settings, or start a new chat.`
    : warn
      ? `Approaching cap (${Math.round(pct * 100)}%). Click to raise.`
      : `${Math.round(pct * 100)}% of cap used. Click to adjust.`;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors', color)}
      title={tooltipBase + usdNote + staleNote}
    >
      {over ? <AlertCircle className="w-3 h-3" /> : <Icon className="w-3 h-3" />}
      <span className="text-[11px] font-mono whitespace-nowrap">
        {consumedText} / {limitText}
      </span>
    </button>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
}
