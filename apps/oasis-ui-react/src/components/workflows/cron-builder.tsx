/**
 * Friendly cron expression builder — shared between the Triggers side tab
 * and the per-trigger-node inspector on the canvas. Exposes:
 *
 *   • CronBuilder — React component (select preset + typed inputs)
 *   • CronBuilderState — the builder's internal state shape
 *   • defaultBuilderState / stateFromExpression — helpers
 *   • buildCron(state)   → returns a 5-field cron expression
 *   • humanize(expr)     → returns a human-readable gloss
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

type CronPreset = 'every_n_minutes' | 'every_n_hours' | 'daily' | 'weekly' | 'advanced';

const WEEKDAYS = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

export interface CronBuilderState {
  preset: CronPreset;
  minutes: number;
  hours: number;
  at_hour: number;
  at_minute: number;
  weekdays: number[];
  advanced: string;
}

export function defaultBuilderState(): CronBuilderState {
  return {
    preset: 'daily',
    minutes: 5,
    hours: 1,
    at_hour: 9,
    at_minute: 0,
    weekdays: [1],
    advanced: '0 9 * * *',
  };
}

export function buildCron(state: CronBuilderState): string {
  switch (state.preset) {
    case 'every_n_minutes':
      return `*/${Math.max(1, state.minutes)} * * * *`;
    case 'every_n_hours':
      return `0 */${Math.max(1, state.hours)} * * *`;
    case 'daily':
      return `${state.at_minute} ${state.at_hour} * * *`;
    case 'weekly': {
      const days = state.weekdays.length > 0 ? state.weekdays.slice().sort().join(',') : '1';
      return `${state.at_minute} ${state.at_hour} * * ${days}`;
    }
    case 'advanced':
      return state.advanced.trim() || '* * * * *';
  }
}

/** Best-effort reverse: parse an existing cron expression into builder state. */
export function stateFromExpression(expr: string, base?: Partial<CronBuilderState>): CronBuilderState {
  const s = expr.trim();
  const def = { ...defaultBuilderState(), ...base };
  const m1 = s.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m1) return { ...def, preset: 'every_n_minutes', minutes: Number(m1[1]) || 5, advanced: s };
  const m2 = s.match(/^0 \*\/(\d+) \* \* \*$/);
  if (m2) return { ...def, preset: 'every_n_hours', hours: Number(m2[1]) || 1, advanced: s };
  const m3 = s.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (m3) return { ...def, preset: 'daily', at_minute: Number(m3[1]) || 0, at_hour: Number(m3[2]) || 9, advanced: s };
  const m4 = s.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/);
  if (m4) return {
    ...def,
    preset: 'weekly',
    at_minute: Number(m4[1]) || 0,
    at_hour: Number(m4[2]) || 9,
    weekdays: m4[3].split(',').map(Number),
    advanced: s,
  };
  return { ...def, preset: 'advanced', advanced: s || '* * * * *' };
}

export function humanize(expr: string): string {
  const s = (expr || '').trim();
  const m1 = s.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m1) return `Every ${m1[1]} minute${m1[1] === '1' ? '' : 's'}`;
  const m2 = s.match(/^0 \*\/(\d+) \* \* \*$/);
  if (m2) return `Every ${m2[1]} hour${m2[1] === '1' ? '' : 's'}, on the hour`;
  const m3 = s.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (m3) return `Daily at ${String(m3[2]).padStart(2, '0')}:${String(m3[1]).padStart(2, '0')}`;
  const m4 = s.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/);
  if (m4) {
    const days = m4[3].split(',').map(d => WEEKDAYS[+d]?.label).filter(Boolean).join('/');
    return `${days} at ${String(m4[2]).padStart(2, '0')}:${String(m4[1]).padStart(2, '0')}`;
  }
  return s || '(no schedule)';
}

export function CronBuilder({
  value, onChange,
}: {
  value: CronBuilderState;
  onChange: (next: CronBuilderState) => void;
}) {
  const expression = useMemo(() => buildCron(value), [value]);

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] text-slate-400">Schedule</label>
      <select
        value={value.preset}
        onChange={e => onChange({ ...value, preset: e.target.value as CronPreset })}
        className="text-[11px] bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
      >
        <option value="every_n_minutes">Every N minutes</option>
        <option value="every_n_hours">Every N hours</option>
        <option value="daily">Daily at a specific time</option>
        <option value="weekly">On chosen weekdays at a specific time</option>
        <option value="advanced">Advanced (raw cron)</option>
      </select>

      {value.preset === 'every_n_minutes' && (
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          every
          <input
            type="number" min={1} max={59}
            value={value.minutes}
            onChange={e => onChange({ ...value, minutes: Math.max(1, +e.target.value || 1) })}
            className="w-16 text-[11px] bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
          />
          minutes
        </label>
      )}

      {value.preset === 'every_n_hours' && (
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          every
          <input
            type="number" min={1} max={23}
            value={value.hours}
            onChange={e => onChange({ ...value, hours: Math.max(1, +e.target.value || 1) })}
            className="w-16 text-[11px] bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
          />
          hours, on the hour
        </label>
      )}

      {(value.preset === 'daily' || value.preset === 'weekly') && (
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          at
          <input
            type="number" min={0} max={23}
            value={value.at_hour}
            onChange={e => onChange({ ...value, at_hour: Math.max(0, Math.min(23, +e.target.value || 0)) })}
            className="w-14 text-[11px] bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
          />
          :
          <input
            type="number" min={0} max={59}
            value={value.at_minute}
            onChange={e => onChange({ ...value, at_minute: Math.max(0, Math.min(59, +e.target.value || 0)) })}
            className="w-14 text-[11px] bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
          />
        </label>
      )}

      {value.preset === 'weekly' && (
        <div className="flex flex-wrap gap-1">
          {WEEKDAYS.map(d => {
            const on = value.weekdays.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => onChange({
                  ...value,
                  weekdays: on ? value.weekdays.filter(x => x !== d.value) : [...value.weekdays, d.value],
                })}
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded border',
                  on ? 'bg-emerald-900/30 border-emerald-800/50 text-emerald-300'
                     : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200',
                )}
              >{d.label}</button>
            );
          })}
        </div>
      )}

      {value.preset === 'advanced' && (
        <>
          <label className="text-[10px] text-slate-500">Raw cron (5 fields): minute hour dom month dow</label>
          <input
            type="text"
            value={value.advanced}
            onChange={e => onChange({ ...value, advanced: e.target.value })}
            placeholder="0 9 * * MON"
            className="w-full text-[11px] bg-slate-900 border border-slate-800 rounded px-2 py-1 font-mono"
          />
        </>
      )}

      <p className="text-[10px] text-slate-500">
        Expression: <span className="font-mono text-slate-300">{expression}</span>
        {' · '}<span className="text-slate-400">{humanize(expression)}</span>
      </p>
    </div>
  );
}
