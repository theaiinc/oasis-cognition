/**
 * Project Roles — CRUD over `/api/v1/project-roles`, scoped to the active
 * project. Role descriptions are injected as system-prompt preambles when
 * an agent spawns through the role.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Plus, Trash2, Save, Loader2, UserCircle, Sparkles, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';

const ROLES_API = `${OASIS_BASE_URL}/api/v1/project-roles`;
const PROFILES_API = `${OASIS_BASE_URL}/api/v1/agent-profiles`;

type RoleKind = 'researcher' | 'developer' | 'data_analyst' | 'designer' | 'custom';

interface ProjectRole {
  role_id: string;
  project_id: string;
  name: string;
  kind: RoleKind;
  description: string;
  agent_profile_id?: string;
  created_at: string;
  updated_at: string;
}

interface AgentProfileSummary {
  profile_id: string;
  name: string;
  agent_type: string;
  config: { model?: string };
}

type Draft = Omit<ProjectRole, 'role_id' | 'created_at' | 'updated_at'>;

function blankDraft(projectId: string): Draft {
  return { project_id: projectId, name: '', kind: 'custom', description: '', agent_profile_id: undefined };
}

interface ProjectRolesViewProps {
  activeProjectId?: string;
  activeProjectName?: string;
}

export function ProjectRolesView({ activeProjectId, activeProjectName }: ProjectRolesViewProps) {
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchRoles = useCallback(async () => {
    if (!activeProjectId) { setRoles([]); setLoading(false); return; }
    try {
      const res = await axios.get(ROLES_API, { params: { project_id: activeProjectId } });
      setRoles(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [activeProjectId]);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await axios.get(PROFILES_API);
      setProfiles(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchRoles(); fetchProfiles(); }, [fetchRoles, fetchProfiles]);

  const selected = useMemo(
    () => roles.find(r => r.role_id === selectedId) || null,
    [roles, selectedId],
  );

  useEffect(() => {
    if (!selected) { setDraft(null); setDirty(false); return; }
    setDraft({
      project_id: selected.project_id,
      name: selected.name,
      kind: selected.kind,
      description: selected.description,
      agent_profile_id: selected.agent_profile_id,
    });
    setDirty(false);
  }, [selected?.role_id, selected?.updated_at]);

  const seedPresets = async () => {
    if (!activeProjectId) return;
    setLoading(true);
    try {
      await axios.post(`${ROLES_API}/seed-presets?project_id=${encodeURIComponent(activeProjectId)}`);
      await fetchRoles();
    } catch (e: any) { setErr(e?.message || 'seed failed'); }
    finally { setLoading(false); }
  };

  const startNew = () => {
    if (!activeProjectId) return;
    setSelectedId(null);
    setDraft(blankDraft(activeProjectId));
    setDirty(true);
  };

  const save = async () => {
    if (!draft || !activeProjectId) return;
    if (draft.kind === 'custom' && !draft.description.trim()) {
      setErr('Custom roles require a description.');
      return;
    }
    setSaving(true); setErr(null);
    try {
      if (selectedId) {
        const res = await axios.patch(`${ROLES_API}/${selectedId}`, draft);
        setSelectedId(res.data.role_id);
      } else {
        const res = await axios.post(ROLES_API, { ...draft, project_id: activeProjectId });
        setSelectedId(res.data.role_id);
      }
      await fetchRoles();
      setDirty(false);
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'save failed');
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this role?')) return;
    try {
      await axios.delete(`${ROLES_API}/${id}`);
      if (selectedId === id) { setSelectedId(null); setDraft(null); }
      await fetchRoles();
    } catch (e: any) { setErr(e?.message || 'delete failed'); }
  };

  const patch = (p: Partial<Draft>) => {
    setDraft(d => d ? { ...d, ...p } : d);
    setDirty(true);
  };

  if (!activeProjectId) {
    return (
      <div className="flex items-center justify-center h-full p-6 text-center">
        <div className="text-xs text-slate-500">
          Activate a project from the sidebar to manage its roles.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-[240px] border-r border-slate-800 flex flex-col">
        <div className="p-3 border-b border-slate-800 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-300">Roles</div>
            {activeProjectName && (
              <div className="text-[10px] text-slate-600 font-mono truncate">{activeProjectName}</div>
            )}
          </div>
          <Button size="sm" variant="ghost" className="h-6 text-[10px] text-emerald-400 hover:text-emerald-300" onClick={startNew}>
            <Plus className="w-3 h-3" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {loading && <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 text-emerald-400 animate-spin" /></div>}
          {!loading && roles.length === 0 && (
            <div className="p-2 flex flex-col gap-2">
              <p className="text-[11px] text-slate-500">No roles yet for this project.</p>
              <Button size="sm" className="h-7 text-[11px]" onClick={seedPresets}>
                <Sparkles className="w-3 h-3 mr-1" /> Seed preset roles
              </Button>
            </div>
          )}
          {roles.map(r => {
            const selectedHere = r.role_id === selectedId;
            const profile = profiles.find(p => p.profile_id === r.agent_profile_id);
            return (
              <button
                key={r.role_id}
                onClick={() => setSelectedId(r.role_id)}
                className={cn(
                  'w-full text-left p-2 rounded transition-colors text-xs',
                  selectedHere ? 'bg-emerald-900/30 border border-emerald-800/50' : 'hover:bg-slate-800/50 border border-transparent',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <UserCircle className="w-3 h-3 text-slate-400" />
                  <span className="text-slate-200 truncate flex-1">{r.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-slate-600 font-mono">{r.kind}</span>
                  {profile ? (
                    <span className="text-[10px] text-emerald-400 font-mono truncate">
                      · {profile.name}
                    </span>
                  ) : (
                    <span className="text-[10px] text-amber-500">· unassigned</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {!draft ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-slate-500">Select a role on the left, or click <kbd className="px-1 border border-slate-700 rounded text-[10px]">+</kbd> to create one.</p>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-3 max-w-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">
                {selectedId ? 'Edit role' : 'New role'}
              </h3>
              <div className="flex items-center gap-2">
                {selectedId && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-red-400 hover:text-red-300" onClick={() => remove(selectedId)}>
                    <Trash2 className="w-3 h-3 mr-1" /> Delete
                  </Button>
                )}
                <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving || !dirty}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                  Save
                </Button>
              </div>
            </div>

            {err && <p className="text-[11px] text-red-400">{err}</p>}

            <Field label="Kind">
              <select
                value={draft.kind}
                onChange={e => patch({ kind: e.target.value as RoleKind })}
                className={inputCls}
              >
                <option value="researcher">Researcher (preset)</option>
                <option value="developer">Developer (preset)</option>
                <option value="data_analyst">Data analyst (preset)</option>
                <option value="designer">Designer (preset)</option>
                <option value="custom">Custom</option>
              </select>
            </Field>

            <Field label="Name">
              <input
                type="text"
                value={draft.name}
                onChange={e => patch({ name: e.target.value })}
                placeholder="Role title"
                className={inputCls}
              />
            </Field>

            <Field
              label="Description"
              help={
                draft.kind === 'custom'
                  ? 'Required for custom roles. Injected as a system-prompt preamble when spawning.'
                  : 'Injected as a system-prompt preamble. Preset default is shown; edit to taste.'
              }
            >
              <textarea
                value={draft.description}
                onChange={e => patch({ description: e.target.value })}
                rows={6}
                placeholder="You are …"
                className={cn(inputCls, 'resize-y font-mono')}
              />
            </Field>

            <Field label="Agent profile" help="Which profile plays this role. Leave blank to define the role now and bind an agent later.">
              <select
                value={draft.agent_profile_id || ''}
                onChange={e => patch({ agent_profile_id: e.target.value || undefined })}
                className={inputCls}
              >
                <option value="">(unassigned)</option>
                {profiles.map(p => (
                  <option key={p.profile_id} value={p.profile_id}>
                    {p.name} — {p.agent_type}{p.config.model ? ` / ${p.config.model}` : ''}
                  </option>
                ))}
              </select>
              {profiles.length === 0 && (
                <p className="text-[10px] text-amber-400/80 mt-1">No profiles yet — switch to the Profiles tab first to create one.</p>
              )}
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

const inputCls = 'w-full text-[12px] text-slate-200 bg-slate-950/60 border border-slate-800 rounded px-2 py-1';

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] text-slate-300 font-medium">{label}</label>
      {children}
      {help && <p className="text-[10px] text-slate-500 leading-snug">{help}</p>}
    </div>
  );
}

// silence unused-import complaints from lucide
void X;
