/**
 * RolePicker — compact chip-style selector that lets the user pick the project
 * role the assistant should play for subsequent chat turns. The chosen role's
 * bound agent profile drives model routing + system-prompt preamble in the
 * interaction pipeline (api-gateway → response-generator).
 *
 * Selection is persisted per project in localStorage so it survives reloads.
 * When no project is active, the picker hides itself.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { UserCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';

const ROLES_API = `${OASIS_BASE_URL}/api/v1/project-roles`;
const PROFILES_API = `${OASIS_BASE_URL}/api/v1/agent-profiles`;

interface Role {
  role_id: string;
  name: string;
  kind: string;
  agent_profile_id?: string;
}
interface Profile {
  profile_id: string;
  name: string;
  agent_type: string;
  config: { model?: string };
}

function storageKey(projectId: string) {
  return `oasis-active-role:${projectId}`;
}

interface RolePickerProps {
  activeProjectId?: string;
  /** Currently selected role_id (or null/undefined for none). */
  value: string | null;
  onChange: (roleId: string | null) => void;
}

export function RolePicker({ activeProjectId, value, onChange }: RolePickerProps) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [open, setOpen] = useState(false);

  // Hydrate from localStorage on project switch
  useEffect(() => {
    if (!activeProjectId) { onChange(null); return; }
    const raw = localStorage.getItem(storageKey(activeProjectId));
    onChange(raw || null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) { setRoles([]); return; }
    axios.get(ROLES_API, { params: { project_id: activeProjectId } })
      .then(res => setRoles(Array.isArray(res.data) ? res.data : []))
      .catch(() => setRoles([]));
    axios.get(PROFILES_API)
      .then(res => setProfiles(Array.isArray(res.data) ? res.data : []))
      .catch(() => setProfiles([]));
  }, [activeProjectId]);

  const select = useCallback((id: string | null) => {
    if (!activeProjectId) return;
    if (id) localStorage.setItem(storageKey(activeProjectId), id);
    else localStorage.removeItem(storageKey(activeProjectId));
    onChange(id);
    setOpen(false);
  }, [activeProjectId, onChange]);

  const active = useMemo(() => roles.find(r => r.role_id === value) || null, [roles, value]);
  const activeProfile = useMemo(() =>
    active?.agent_profile_id ? profiles.find(p => p.profile_id === active.agent_profile_id) || null : null,
  [active, profiles]);

  if (!activeProjectId) return null;

  // Closed-state copy: "No role" is the persisted-selection placeholder, but it
  // reads as "no roles available" when the project actually has presets. Show
  // a count instead so the user knows the picker has options without opening it.
  const closedLabel = active
    ? active.name
    : roles.length > 0
      ? `Pick role · ${roles.length}`
      : 'No role';

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border transition-colors',
          active
            ? 'bg-emerald-900/30 border-emerald-800/50 text-emerald-300 hover:bg-emerald-900/40'
            : roles.length > 0
              ? 'bg-blue-900/20 border-blue-800/40 text-blue-300 hover:bg-blue-900/30'
              : 'bg-slate-800/60 border-slate-700/50 text-slate-400 hover:bg-slate-800',
        )}
        title={
          active
            ? `Role: ${active.name}${activeProfile ? ` · ${activeProfile.name}` : ''}`
            : roles.length > 0
              ? `${roles.length} role${roles.length === 1 ? '' : 's'} available — click to pick`
              : 'No roles in this project'
        }
      >
        <UserCircle className="w-3 h-3" />
        <span className="truncate max-w-[140px]">{closedLabel}</span>
        {activeProfile?.config?.model && (
          <span className="text-[9px] font-mono text-emerald-400/70">
            {activeProfile.config.model}
          </span>
        )}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open && (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1 left-0 z-20 min-w-[220px] rounded-md border border-slate-800 bg-slate-950/95 backdrop-blur shadow-lg p-1 text-xs">
            <button
              type="button"
              onClick={() => select(null)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded hover:bg-slate-800/60',
                !value && 'bg-slate-800/40',
              )}
            >
              <div className="text-slate-200">No role</div>
              <div className="text-[10px] text-slate-500">Default chat routing</div>
            </button>
            {roles.length === 0 && (
              <div className="px-2 py-1.5 text-[10px] text-slate-500">
                No roles in this project. Open the Agents panel → Roles to add one.
              </div>
            )}
            {roles.map(r => {
              const p = r.agent_profile_id ? profiles.find(x => x.profile_id === r.agent_profile_id) : null;
              return (
                <button
                  key={r.role_id}
                  type="button"
                  onClick={() => select(r.role_id)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded hover:bg-slate-800/60',
                    value === r.role_id && 'bg-emerald-900/20',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <UserCircle className="w-3 h-3 text-slate-400" />
                    <span className="text-slate-200 truncate">{r.name}</span>
                    <span className="text-[9px] text-slate-600 font-mono">{r.kind}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono truncate">
                    {p ? `${p.name}${p.config?.model ? ` · ${p.config.model}` : ''}` : 'unassigned'}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
