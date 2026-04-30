/**
 * Manage triggers (cron / event / manual) attached to a workflow.
 */

import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Trash2, Check, X, Clock, Radio, Play, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';
import type { Trigger, TriggerType } from './types';
import {
  CronBuilder, buildCron, humanize, defaultBuilderState, type CronBuilderState,
} from './cron-builder';

const API = `${OASIS_BASE_URL}/api/v1/workflows`;

export function TriggersEditor({ workflowId }: { workflowId: string }) {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<null | TriggerType>(null);
  const [cronBuilder, setCronBuilder] = useState<CronBuilderState>(defaultBuilderState());
  const [newCronTz, setNewCronTz] = useState<string>(
    (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
  );
  const [newEventType, setNewEventType] = useState('FeedbackReceived');
  const [newEventFilter, setNewEventFilter] = useState('{}');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/${workflowId}/triggers`);
      setTriggers(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (type: TriggerType) => {
    setErr(null);
    try {
      let config: Record<string, any> = {};
      if (type === 'cron') {
        const expression = buildCron(cronBuilder);
        config = { expression, timezone: newCronTz.trim() || 'UTC' };
      } else if (type === 'event') {
        let filter: Record<string, any> = {};
        try { filter = newEventFilter.trim() ? JSON.parse(newEventFilter) : {}; }
        catch (e: any) { throw new Error(`filter: ${e.message}`); }
        config = newEventType ? { event_type: newEventType, ...(Object.keys(filter).length ? { filter } : {}) } : (Object.keys(filter).length ? { filter } : {});
      }
      await axios.post(`${API}/${workflowId}/triggers`, { type, config });
      setAdding(null);
      await load();
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'failed');
    }
  }, [workflowId, cronBuilder, newCronTz, newEventType, newEventFilter, load]);

  const toggle = useCallback(async (t: Trigger) => {
    try {
      await axios.patch(`${API}/triggers/${t.trigger_id}`, { enabled: !t.enabled });
      await load();
    } catch { /* silent */ }
  }, [load]);

  const remove = useCallback(async (t: Trigger) => {
    try {
      await axios.delete(`${API}/triggers/${t.trigger_id}`);
      setTriggers(prev => prev.filter(x => x.trigger_id !== t.trigger_id));
    } catch { /* silent */ }
  }, []);

  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-slate-300 font-semibold">Triggers</h3>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setAdding('cron')}>
            <Clock className="w-3 h-3 mr-1" /> cron
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setAdding('event')}>
            <Radio className="w-3 h-3 mr-1" /> event
          </Button>
        </div>
      </div>
      <p className="text-[10px] text-slate-500 leading-snug">
        You can also drop a <span className="font-mono text-amber-400">trigger</span> node on the canvas — it'll appear here automatically as a synced trigger.
      </p>

      {loading && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 text-purple-400 animate-spin" /></div>}
      {!loading && triggers.length === 0 && !adding && (
        <p className="text-slate-500 text-[11px]">No triggers. Add one above, or run the workflow manually.</p>
      )}

      {triggers.map(t => (
        <div key={t.trigger_id} className={cn(
          'rounded border p-2 flex items-start gap-2',
          t.enabled ? 'border-slate-800/50 bg-slate-950/40' : 'border-slate-800/30 bg-slate-950/20 opacity-60',
        )}>
          {t.type === 'cron' && <Clock className="w-3 h-3 text-slate-400 mt-0.5" />}
          {t.type === 'event' && <Radio className="w-3 h-3 text-slate-400 mt-0.5" />}
          {t.type === 'manual' && <Play className="w-3 h-3 text-slate-400 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <div className="text-slate-300 text-[11px] truncate">
              {t.type === 'cron' && (
                <>
                  <span className="text-slate-200">{humanize((t.config as any)?.expression || '')}</span>
                  <span className="text-slate-500"> · {(t.config as any)?.timezone || 'UTC'}</span>
                </>
              )}
              {t.type === 'event' && (
                <span className="font-mono">
                  {(t.config as any)?.event_type ? `event: ${(t.config as any).event_type}` : 'any event'}
                </span>
              )}
              {t.type === 'manual' && 'manual'}
            </div>
            {t.type === 'cron' && (
              <div className="text-[10px] text-slate-600 font-mono truncate">
                {(t.config as any)?.expression}
              </div>
            )}
            {t.type === 'event' && (t.config as any)?.filter && (
              <div className="text-[10px] text-slate-500 truncate">filter: {JSON.stringify((t.config as any).filter)}</div>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1" onClick={() => toggle(t)}>
            {t.enabled ? 'on' : 'off'}
          </Button>
          <Button variant="ghost" size="icon" className="w-5 h-5 text-slate-500 hover:text-red-400" onClick={() => remove(t)}>
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}

      {adding === 'cron' && (
        <div className="rounded border border-slate-800 p-2 bg-slate-950/40 flex flex-col gap-2">
          <CronBuilder value={cronBuilder} onChange={setCronBuilder} />
          <label className="text-[10px] text-slate-400">Timezone (IANA)</label>
          <input
            value={newCronTz}
            onChange={e => setNewCronTz(e.target.value)}
            placeholder="America/Los_Angeles"
            className="text-[11px] bg-slate-900 border border-slate-800 rounded px-2 py-1 font-mono"
          />
          <div className="flex justify-end gap-1 mt-1">
            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setAdding(null)}>
              <X className="w-3 h-3" />
            </Button>
            <Button size="sm" className="h-6 text-[10px]" onClick={() => save('cron')}>
              <Check className="w-3 h-3 mr-1" /> Save
            </Button>
          </div>
        </div>
      )}

      {adding === 'event' && (
        <div className="rounded border border-slate-800 p-2 bg-slate-950/40 flex flex-col gap-1.5">
          <label className="text-[10px] text-slate-400">Match event_type (or leave blank for any)</label>
          <input
            value={newEventType}
            onChange={e => setNewEventType(e.target.value)}
            placeholder="FeedbackReceived"
            className="text-[11px] bg-slate-900 border border-slate-800 rounded px-2 py-1 font-mono"
          />
          <label className="text-[10px] text-slate-400">Filter JSON (dotted paths over the event)</label>
          <textarea
            value={newEventFilter}
            onChange={e => setNewEventFilter(e.target.value)}
            rows={3}
            placeholder='{"payload.session_id": "abc"}'
            className="text-[11px] bg-slate-900 border border-slate-800 rounded px-2 py-1 font-mono resize-y"
          />
          <div className="flex justify-end gap-1 mt-1">
            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setAdding(null)}>
              <X className="w-3 h-3" />
            </Button>
            <Button size="sm" className="h-6 text-[10px]" onClick={() => save('event')}>
              <Check className="w-3 h-3 mr-1" /> Save
            </Button>
          </div>
        </div>
      )}

      {err && <div className="text-[10px] text-red-400">{err}</div>}
    </div>
  );
}
