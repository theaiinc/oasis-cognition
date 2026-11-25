import { useState } from 'react';
import axios from 'axios';
import { Check, Clock, Loader2, MessageSquarePlus, Sparkles, X } from 'lucide-react';
import { OASIS_BASE_URL } from '@/lib/constants';
import { BRAND_SHORT_NAME } from '@/lib/brand';
import {
  missionCreateBody, missionRequestText, templatesByCategory, type MissionTemplate,
} from '@/lib/mission-templates';

interface Props {
  /** Fill the chat input with a ready-to-send mission request. */
  onPick: (prompt: string) => void;
  /** The chat's project and session: a mission created here belongs to the project and reports to this chat. */
  projectId?: string | null;
  sessionId?: string | null;
  /** After a mission was created directly (refresh the active-missions bar). */
  onCreated?: () => void;
  onClose: () => void;
}

/**
 * Gallery of mission templates (lib/mission-templates.ts), grouped by category. Each
 * template either goes into the chat as a mission_create request the user can edit and
 * send, or is created straight away through /api/v1/missions after a confirmation.
 */
export function MissionTemplateGallery({ onPick, projectId, sessionId, onCreated, onClose }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const create = async (t: MissionTemplate) => {
    setBusy(t.id);
    setError(null);
    try {
      await axios.post(`${OASIS_BASE_URL}/api/v1/missions`, missionCreateBody(t, { projectId, sessionId }));
      setCreated((c) => ({ ...c, [t.id]: true }));
      setConfirming(null);
      onCreated?.();
    } catch (err: any) {
      const detail = err?.response?.data?.message || err?.message || 'unknown error';
      setError(`Couldn't create "${t.title}": ${detail}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full max-w-3xl rounded-lg border border-violet-900/40 bg-violet-950/10 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-violet-300">
          <Sparkles className="w-3 h-3" /> Mission templates
        </div>
        <button type="button" onClick={onClose} className="p-1 rounded text-slate-500 hover:text-slate-200" title="Close templates" aria-label="Close templates">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3 leading-snug">
        Put one in the chat to adjust it first, or create it now: {BRAND_SHORT_NAME} runs it on its schedule and posts each result to this chat.
      </p>
      {error && <div className="mb-2 rounded-md border border-red-900/50 bg-red-950/30 px-2.5 py-1.5 text-[11px] text-red-300">{error}</div>}
      <div className="flex flex-col gap-3">
        {templatesByCategory().map((group) => (
          <section key={group.id}>
            <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5 px-0.5">{group.label}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {group.templates.map((t) => (
                <div key={t.id} className="rounded-md border border-slate-800/70 bg-slate-900/50 p-2.5 flex flex-col gap-1.5">
                  <div className="text-[12px] font-medium text-slate-200">{t.title}</div>
                  <div className="text-[11px] text-slate-400 leading-snug">{t.summary}</div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1" title={`cron ${t.schedule}`}><Clock className="w-3 h-3" />{t.scheduleLabel}</span>
                  </div>
                  {confirming === t.id ? (
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <span className="text-[11px] text-violet-200 flex-1">Create this mission now?</span>
                      <button
                        type="button"
                        disabled={busy === t.id}
                        onClick={() => void create(t)}
                        className="rounded px-2 py-0.5 text-[11px] bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-60 flex items-center gap-1"
                      >
                        {busy === t.id && <Loader2 className="w-3 h-3 animate-spin" />} Create
                      </button>
                      <button type="button" onClick={() => setConfirming(null)} className="rounded px-2 py-0.5 text-[11px] text-slate-400 hover:text-slate-200">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => onPick(missionRequestText(t))}
                        className="rounded px-2 py-0.5 text-[11px] text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1"
                      >
                        <MessageSquarePlus className="w-3 h-3" /> Put in chat
                      </button>
                      {created[t.id] ? (
                        <span className="text-[11px] text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> Created</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setConfirming(t.id); setError(null); }}
                          className="rounded px-2 py-0.5 text-[11px] text-violet-300 hover:text-violet-100 hover:bg-violet-950/40"
                        >
                          Create now…
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
