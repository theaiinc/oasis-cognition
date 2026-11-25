import { useState } from 'react';
import { Check, FileDiff, ShieldCheck, X } from 'lucide-react';
import { BRAND_SHORT_NAME } from '@/lib/brand';
import { diffLines, diffStat, timeLeft, type PendingEdit } from '@/lib/edit-approval';

const LINE_CLASS = {
  add: 'text-emerald-300 bg-emerald-950/40',
  del: 'text-rose-300 bg-rose-950/40',
  hunk: 'text-sky-400',
  file: 'text-slate-400 font-semibold',
  context: 'text-slate-300',
} as const;

/** Toggle beside the work mode: with it on, each file change waits for your approval. */
export function ReviewEditsChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={on
        ? `Review edits is on: each file change ${BRAND_SHORT_NAME} makes in this chat waits for you to approve or reject it.`
        : `Review edits: approve or reject each file change ${BRAND_SHORT_NAME} makes in this chat before it is written.`}
      className={on
        ? 'inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border bg-amber-900/40 border-amber-700/60 text-amber-200'
        : 'inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border bg-slate-800/60 border-slate-700/50 text-slate-400 hover:text-slate-200'}
    >
      <ShieldCheck className="w-3 h-3" />
      Review edits{on ? ': on' : ''}
    </button>
  );
}

function PendingCard({ edit, more, onDecide }: {
  edit: PendingEdit;
  more: number;
  onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<boolean>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const stat = diffStat(edit.diff);
  const send = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    try { await onDecide(edit.approval_id, decision, decision === 'rejected' ? reason : undefined); } finally { setBusy(false); }
  };
  return (
    <div className="mb-2 rounded-xl border border-amber-800/50 bg-amber-950/20 text-[12px] text-amber-100" role="region" aria-label="Change waiting for approval">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <FileDiff className="w-3.5 h-3.5 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1">
          {BRAND_SHORT_NAME} wants to {edit.tool === 'write_file' ? 'write' : 'edit'} <code className="font-mono text-amber-200 break-all">{edit.path || 'a file'}</code>
          <span className="ml-2 text-emerald-300">+{stat.added}</span> <span className="text-rose-300">−{stat.removed}</span>
          <span className="ml-2 text-amber-300/70">{timeLeft(edit.expires_at)}{more ? ` · ${more} more waiting` : ''}</span>
        </span>
      </div>
      {edit.reasoning && <p className="px-3 pb-1 text-amber-200/80">{edit.reasoning}</p>}
      <pre className="mx-3 mb-2 max-h-64 overflow-auto rounded-md border border-slate-800 bg-slate-950/80 py-1 font-mono text-[11px] leading-[1.45]">
        {diffLines(edit.diff).map((l, i) => (
          <div key={i} className={`px-2 whitespace-pre ${LINE_CLASS[l.kind]}`}>{l.text || ' '}</div>
        ))}
      </pre>
      {edit.truncated && <p className="px-3 pb-1 text-amber-300/70">The change is longer than shown here.</p>}
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        {rejecting ? (
          <>
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send('rejected'); if (e.key === 'Escape') setRejecting(false); }}
              placeholder="Why? (optional, sent to the agent)"
              maxLength={1000}
              className="min-w-[12rem] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 placeholder:text-slate-500"
            />
            <button type="button" disabled={busy} onClick={() => setRejecting(false)} className="px-2 py-1 rounded text-amber-300 hover:bg-amber-900/40">Back</button>
            <button type="button" disabled={busy} onClick={() => void send('rejected')} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white font-medium disabled:opacity-60">
              <X className="w-3 h-3" /> Reject change
            </button>
          </>
        ) : (
          <>
            <span className="flex-1" />
            <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="inline-flex items-center gap-1 px-2 py-1 rounded text-rose-300 hover:bg-rose-900/30">
              <X className="w-3 h-3" /> Reject
            </button>
            <button type="button" disabled={busy} onClick={() => void send('approved')} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-60">
              <Check className="w-3 h-3" /> Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Shown above the input while a file change waits for the user's approval (oldest first). */
export function EditApprovalBar({ pending, onDecide }: {
  pending: PendingEdit[];
  onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<boolean>;
}) {
  if (!pending.length) return null;
  const first = pending[0];
  return <PendingCard key={first.approval_id} edit={first} more={pending.length - 1} onDecide={onDecide} />;
}
