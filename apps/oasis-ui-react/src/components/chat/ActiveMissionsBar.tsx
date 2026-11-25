import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Pause, Play, RefreshCw, Trash2, Clock, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { OASIS_BASE_URL } from '@/lib/constants';
import { listProjects } from '@/lib/artifact-api';
import { ALL_MISSIONS, NO_PROJECT, NO_ROLE, bulkBody, filterMissions, filterOptions, type MissionFilter } from '@/lib/mission-filters';

export interface MissionRow {
  mission_id: string;
  goal: string;
  schedule: string;
  enabled: boolean;
  state: 'idle' | 'running' | 'paused' | 'failed';
  last_run_at?: string;
  next_run_at?: string;
  run_count?: number;
  project_id?: string;
  role_id?: string;
}

interface Props {
  missions: MissionRow[];
  /** Mutates server state then expects parent to refresh. */
  onMutated: () => void;
}

/**
 * Compact "what Oasis is watching for me right now" strip pinned at the top of
 * the chat. Replaces the idea of a separate Missions panel — missions are
 * first-class chat citizens, visible without navigation. Hidden entirely when
 * there are no missions so the chat doesn't get a permanent header rail.
 */
export function ActiveMissionsBar({ missions, onMutated }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<MissionFilter>(ALL_MISSIONS);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const options = useMemo(() => filterOptions(missions || []), [missions]);
  const hasProjects = options.projects.length > 0;

  // Project names for the filter menu, once there is a project to name.
  useEffect(() => {
    if (!hasProjects) return;
    let cancelled = false;
    listProjects()
      .then((ps) => { if (!cancelled) setProjectNames(Object.fromEntries((ps || []).map((p) => [p.project_id, p.name]))); })
      .catch(() => { /* ids are shown instead */ });
    return () => { cancelled = true; };
  }, [hasProjects]);

  // A filter whose project or role no longer has missions falls back to "all".
  useEffect(() => {
    if (filter.project && filter.project !== NO_PROJECT && !options.projects.includes(filter.project)) setFilter((f) => ({ ...f, project: '' }));
    if (filter.role && filter.role !== NO_ROLE && !options.roles.includes(filter.role)) setFilter((f) => ({ ...f, role: '' }));
  }, [filter, options]);

  if (!missions || missions.length === 0) return null;
  const shown = filterMissions(missions, filter);
  const showProjectFilter = options.projects.length > 1 || (hasProjects && options.hasUnprojected);
  const showRoleFilter = options.roles.length > 1 || (options.roles.length > 0 && options.hasRoleless);

  const bulk = async (op: 'pause' | 'resume') => {
    setBusyId(`bulk-${op}`);
    setBulkNote(null);
    try {
      const body = bulkBody(filter);
      if (body) {
        const r = await fetch(`${OASIS_BASE_URL}/api/v1/missions/${op}-all`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
        const res = await r.json() as { changed: unknown[] };
        const n = res.changed?.length ?? 0;
        setBulkNote(`${op === 'pause' ? 'Paused' : 'Resumed'} ${n} mission${n === 1 ? '' : 's'}`);
      } else {
        // "No project" / "no role" can't be said to the bulk endpoint: one by one.
        const targets = shown.filter((m) => (op === 'pause' ? m.enabled || m.state !== 'paused' : !m.enabled || m.state === 'paused'));
        for (const m of targets) {
          const r = await fetch(`${OASIS_BASE_URL}/api/v1/missions/${m.mission_id}/${op}`, { method: 'POST', credentials: 'include' });
          if (!r.ok) throw new Error(await r.text());
        }
        setBulkNote(`${op === 'pause' ? 'Paused' : 'Resumed'} ${targets.length} mission${targets.length === 1 ? '' : 's'}`);
      }
    } catch (err) {
      console.warn(`mission ${op}-all failed`, err);
      setBulkNote(`Couldn't ${op} the missions. Try again.`);
    } finally {
      setBusyId(null);
      onMutated();
    }
  };

  const action = async (id: string, path: string, method: 'POST' | 'DELETE' = 'POST') => {
    setBusyId(id + path);
    try {
      const url = `${OASIS_BASE_URL}/api/v1/missions/${id}${path}`;
      const r = await fetch(url, { method });
      if (!r.ok) throw new Error(await r.text());
    } catch (err) {
      console.warn('mission action failed', err);
    } finally {
      setBusyId(null);
      onMutated();
    }
  };

  const total = missions.length;
  const pausedCount = missions.filter((m) => !m.enabled || m.state === 'paused').length;
  const runningCount = missions.filter((m) => m.state === 'running').length;

  return (
    <div className="mx-3 mt-2 mb-1 rounded-lg border border-violet-900/40 bg-violet-950/15">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-violet-300 hover:text-violet-200"
      >
        <div className="flex items-center gap-2 text-[12px] font-medium">
          {runningCount > 0 ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          <span>
            {total} mission{total === 1 ? '' : 's'}
            {runningCount > 0 && <span className="ml-1 text-violet-400">· {runningCount} running now</span>}
            {runningCount === 0 && pausedCount > 0 && pausedCount === total && <span className="ml-1 text-slate-500">· all paused</span>}
            {runningCount === 0 && pausedCount > 0 && pausedCount < total && <span className="ml-1 text-slate-500">· {pausedCount} paused</span>}
          </span>
        </div>
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1">
          {missions.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 px-0.5 pb-1 text-[11px]">
              {showProjectFilter && (
                <select
                  aria-label="Filter missions by project"
                  value={filter.project}
                  onChange={(e) => setFilter((f) => ({ ...f, project: e.target.value }))}
                  className="h-6 rounded border border-slate-800 bg-slate-900 px-1.5 text-slate-300"
                >
                  <option value="">All projects</option>
                  {options.projects.map((p) => <option key={p} value={p}>{projectNames[p] || p}</option>)}
                  {options.hasUnprojected && <option value={NO_PROJECT}>No project</option>}
                </select>
              )}
              {showRoleFilter && (
                <select
                  aria-label="Filter missions by role"
                  value={filter.role}
                  onChange={(e) => setFilter((f) => ({ ...f, role: e.target.value }))}
                  className="h-6 rounded border border-slate-800 bg-slate-900 px-1.5 text-slate-300"
                >
                  <option value="">All roles</option>
                  {options.roles.map((r) => <option key={r} value={r}>{r}</option>)}
                  {options.hasRoleless && <option value={NO_ROLE}>No role</option>}
                </select>
              )}
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  disabled={!!busyId || shown.every((m) => !m.enabled && m.state === 'paused')}
                  onClick={() => void bulk('pause')}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-40"
                  title={!filter.project && !filter.role ? 'Pause all missions' : 'Pause the missions shown'}
                >
                  {busyId === 'bulk-pause' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />} Pause all
                </button>
                <button
                  type="button"
                  disabled={!!busyId || shown.every((m) => m.enabled && m.state !== 'paused')}
                  onClick={() => void bulk('resume')}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-40"
                  title={!filter.project && !filter.role ? 'Resume all missions' : 'Resume the missions shown'}
                >
                  {busyId === 'bulk-resume' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Resume all
                </button>
              </div>
            </div>
          )}
          {bulkNote && <div className="px-1 pb-1 text-[10px] text-slate-500" role="status">{bulkNote}</div>}
          {shown.length === 0 && <div className="px-1 py-1 text-[11px] text-slate-500">No missions match this filter.</div>}
          {shown.map((m) => (
            <MissionRowView key={m.mission_id} m={m} busyId={busyId} onAction={action} />
          ))}
        </div>
      )}
    </div>
  );
}

function MissionRowView({ m, busyId, onAction }: { m: MissionRow; busyId: string | null; onAction: (id: string, path: string, method?: 'POST' | 'DELETE') => Promise<void> }) {
  const stateColor =
    m.state === 'running' ? 'text-violet-300' :
    m.state === 'failed' ? 'text-red-300' :
    m.state === 'paused' ? 'text-slate-500' :
    'text-emerald-400';
  return (
    <div className="rounded-md bg-slate-900/50 border border-slate-800/60 px-2.5 py-1.5 flex items-center gap-2 text-[11px]">
      <span className={`${stateColor} flex items-center gap-1 shrink-0 font-medium`}>
        {m.state === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
        <span className="uppercase tracking-wider">{m.state}</span>
      </span>
      <span className="flex-1 min-w-0 text-slate-200 truncate" title={m.goal}>{m.goal}</span>
      <span className="shrink-0 text-slate-500 font-mono text-[10px] flex items-center gap-1" title={`Next run: ${m.next_run_at || 'unknown'}`}>
        <Clock className="w-3 h-3" />
        {humanizeCron(m.schedule)}
      </span>
      <div className="flex items-center gap-0.5 shrink-0">
        {m.enabled ? (
          <button
            type="button"
            disabled={!!busyId}
            onClick={() => onAction(m.mission_id, '/pause')}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
            title="Pause"
          >
            <Pause className="w-3 h-3" />
          </button>
        ) : (
          <button
            type="button"
            disabled={!!busyId}
            onClick={() => onAction(m.mission_id, '/resume')}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
            title="Resume"
          >
            <Play className="w-3 h-3" />
          </button>
        )}
        <button
          type="button"
          disabled={!!busyId}
          onClick={() => onAction(m.mission_id, '/run')}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
          title="Run now"
        >
          <RefreshCw className={`w-3 h-3 ${busyId === m.mission_id + '/run' ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          disabled={!!busyId}
          onClick={() => onAction(m.mission_id, '', 'DELETE')}
          className="p-1 rounded text-slate-400 hover:text-red-300 hover:bg-red-950/30 disabled:opacity-50"
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * Best-effort cron → English. Covers the patterns people actually write:
 *   "*\/N * * * *" → "every N min"
 *   "0 * * * *"   → "hourly"
 *   "0 H * * *"   → "daily at H:00"
 *   "0 H * * 1-5" → "weekdays at H:00"
 *   "0 0 * * 0|7" → "Sundays at midnight"
 * Falls back to the raw expression for anything unusual.
 */
function humanizeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hr, dom, mon, dow] = parts;

  const everyN = (s: string) => {
    const m = s.match(/^\*\/(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  };

  if (everyN(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `every ${everyN(min)} min`;
  }
  if (min === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'hourly';
  if (min === '0' && /^\d+$/.test(hr) && dom === '*' && mon === '*' && dow === '*') {
    return `daily at ${hr.padStart(2, '0')}:00`;
  }
  if (min === '0' && /^\d+$/.test(hr) && dom === '*' && mon === '*' && dow === '1-5') {
    return `weekdays at ${hr.padStart(2, '0')}:00`;
  }
  if (min === '0' && hr === '0' && dom === '*' && mon === '*' && (dow === '0' || dow === '7')) {
    return 'Sundays at midnight';
  }
  return expr;
}
