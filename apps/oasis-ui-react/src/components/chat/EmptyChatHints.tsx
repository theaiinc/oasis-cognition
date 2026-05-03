import { Sparkles, ArrowRight } from 'lucide-react';

interface Props {
  onPick: (prompt: string) => void;
  hasMissions: boolean;
}

/**
 * Replaces the generic "Ready to think." empty-state with three concrete
 * suggestions that hint at Oasis's capabilities — including missions, the
 * recurring-background-task primitive most users won't know exists otherwise.
 *
 * Clicking a suggestion populates the chat input rather than sending it
 * immediately — that way the user can edit before committing, and the LLM
 * doesn't fire on a half-baked prompt.
 */
export function EmptyChatHints({ onPick, hasMissions }: Props) {
  // Two columns of suggestions. Left = "what Oasis can do for you in one shot",
  // right = "what Oasis can run for you in the background" (missions).
  const oneShot: Array<{ label: string; prompt: string }> = [
    {
      label: 'Find every TODO comment in this repo',
      prompt: 'Use grep to find every TODO and FIXME comment under apps/ and services/, then group them by file with brief summaries.',
    },
    {
      label: 'Summarise what changed on this branch',
      prompt: 'Show me a summary of what changed since this branch diverged from main — group by feature area, not by commit.',
    },
    {
      label: 'Refactor the diff viewer to add inline comments',
      prompt: 'Plan a refactor of the chat DiffViewer component to support inline review comments — list affected files and propose a 3-step approach.',
    },
  ];
  const missions: Array<{ label: string; prompt: string }> = [
    {
      label: 'Every weekday at 9 — what shipped yesterday',
      prompt: 'Create a mission: every weekday at 9am, summarise what was committed in the last 24 hours and post a digest. Use cron 0 9 * * 1-5.',
    },
    {
      label: 'Every 30 min — new TODOs in the codebase',
      prompt: 'Create a mission: every 30 minutes, scan apps/ and services/ for any new TODO comments added since the previous run and report what changed. Use cron */30 * * * *.',
    },
    {
      label: 'Hourly — open PRs that need my review',
      prompt: 'Create a mission: every hour, list open pull requests waiting on my review and surface anything older than 24 hours. Use cron 0 * * * *.',
    },
  ];

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-10 px-4">
      <div className="flex items-center gap-2">
        <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shadow-lg shadow-blue-900/10">
          <img src="/favicon.svg" alt="Oasis" className="w-9 h-9" draggable={false} />
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-200">Ask Oasis anything.</h3>
          <p className="text-[12px] text-slate-500 leading-snug">One-shot answers, code edits, or recurring background tasks — all from this chat.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-3xl">
        <Column title="Try one of these" items={oneShot} onPick={onPick} />
        <Column
          title={
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-violet-400" />
              {hasMissions ? 'Add another mission' : 'Or start a recurring mission'}
            </span>
          }
          items={missions}
          onPick={onPick}
          violet
        />
      </div>

      <p className="text-[10px] text-slate-600 max-w-md text-center leading-relaxed">
        Missions run on a cron schedule, post digest cards back to this chat, and you can pause / resume / delete them inline. Ask the chat normally and Oasis will turn your goal into a mission for you — no separate UI needed.
      </p>
    </div>
  );
}

function Column({
  title,
  items,
  onPick,
  violet,
}: {
  title: React.ReactNode;
  items: Array<{ label: string; prompt: string }>;
  onPick: (prompt: string) => void;
  violet?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800/70 bg-slate-900/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5 px-1.5">{title}</div>
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            onClick={() => onPick(it.prompt)}
            className={`group/hint text-left rounded-md px-2.5 py-2 text-[12px] leading-snug transition-colors flex items-center justify-between gap-2 ${
              violet
                ? 'hover:bg-violet-950/30 text-slate-300 hover:text-violet-200'
                : 'hover:bg-slate-800/60 text-slate-300 hover:text-slate-100'
            }`}
          >
            <span>{it.label}</span>
            <ArrowRight className={`w-3 h-3 shrink-0 opacity-0 group-hover/hint:opacity-100 transition-opacity ${violet ? 'text-violet-400' : 'text-slate-500'}`} />
          </button>
        ))}
      </div>
    </div>
  );
}
