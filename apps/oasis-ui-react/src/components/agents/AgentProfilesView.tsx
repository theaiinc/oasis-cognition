/**
 * Agent Profiles — CRUD over `/api/v1/agent-profiles`. Profiles are named,
 * reusable configurations: type (internal / claude-code / cursor-cli), model,
 * permission mode, MCP toggle, and an optional system-prompt preamble.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Plus, Trash2, Save, Loader2, Boxes, Sparkles, ScrollText, CheckCircle2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';

const API = `${OASIS_BASE_URL}/api/v1/agent-profiles`;

type ProfileAgentType = 'internal' | 'claude-code' | 'cursor-cli';
type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions' | 'default';

interface AgentProfile {
  profile_id: string;
  name: string;
  description?: string;
  agent_type: ProfileAgentType;
  config: {
    model?: string;
    provider?: 'ollama' | 'openai' | 'anthropic';
    permission_mode?: PermissionMode;
    mcp_enabled?: boolean;
    system_prompt_preamble?: string;
    extra_args?: string[];
  };
  created_at: string;
  updated_at: string;
}

type Draft = Omit<AgentProfile, 'profile_id' | 'created_at' | 'updated_at'>;

function blankDraft(): Draft {
  return {
    name: '',
    description: '',
    agent_type: 'claude-code',
    config: {
      model: '',
      permission_mode: 'acceptEdits',
      mcp_enabled: true,
      system_prompt_preamble: '',
      extra_args: [],
    },
  };
}

export function AgentProfilesView() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const res = await axios.get(API);
      setProfiles(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const selected = useMemo(
    () => profiles.find(p => p.profile_id === selectedId) || null,
    [profiles, selectedId],
  );

  useEffect(() => {
    if (!selected) { setDraft(null); setDirty(false); return; }
    setDraft({
      name: selected.name,
      description: selected.description || '',
      agent_type: selected.agent_type,
      config: { ...selected.config },
    });
    setDirty(false);
  }, [selected?.profile_id, selected?.updated_at]);

  const startNew = () => {
    setSelectedId(null);
    setDraft(blankDraft());
    setDirty(true);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setErr('name is required'); return; }
    setSaving(true); setErr(null);
    try {
      if (selectedId) {
        const res = await axios.patch(`${API}/${selectedId}`, draft);
        setSelectedId(res.data.profile_id);
      } else {
        const res = await axios.post(API, draft);
        setSelectedId(res.data.profile_id);
      }
      await fetchAll();
      setDirty(false);
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'save failed');
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this profile? Bound roles will lose their agent binding.')) return;
    try {
      await axios.delete(`${API}/${id}`);
      if (selectedId === id) { setSelectedId(null); setDraft(null); }
      await fetchAll();
    } catch (e: any) { setErr(e?.message || 'delete failed'); }
  };

  const patch = (p: Partial<Draft>) => {
    setDraft(d => d ? { ...d, ...p, config: { ...d.config, ...(p.config || {}) } } : d);
    setDirty(true);
  };
  const patchCfg = (p: Partial<Draft['config']>) => {
    setDraft(d => d ? { ...d, config: { ...d.config, ...p } } : d);
    setDirty(true);
  };

  const isExternal = draft && draft.agent_type !== 'internal';
  const isInternal = draft && draft.agent_type === 'internal';

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left list */}
      <div className="w-[240px] border-r border-slate-800 flex flex-col">
        <div className="p-3 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">Profiles</span>
          <Button size="sm" variant="ghost" className="h-6 text-[10px] text-emerald-400 hover:text-emerald-300" onClick={startNew}>
            <Plus className="w-3 h-3" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {loading && <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 text-emerald-400 animate-spin" /></div>}
          {!loading && profiles.length === 0 && (
            <p className="text-[11px] text-slate-500 text-center py-6">No profiles yet. Click + to add one.</p>
          )}
          {profiles.map(p => {
            const selectedHere = p.profile_id === selectedId;
            return (
              <button
                key={p.profile_id}
                onClick={() => setSelectedId(p.profile_id)}
                className={cn(
                  'w-full text-left p-2 rounded transition-colors text-xs',
                  selectedHere ? 'bg-emerald-900/30 border border-emerald-800/50' : 'hover:bg-slate-800/50 border border-transparent',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <TypeIcon t={p.agent_type} />
                  <span className="text-slate-200 truncate flex-1">{p.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-slate-600 font-mono">{p.agent_type}</span>
                  {p.config.model && (
                    <span className="text-[10px] text-slate-500 font-mono">· {p.config.model}</span>
                  )}
                  {p.config.permission_mode && p.agent_type !== 'internal' && (
                    <span className="text-[10px] text-slate-500 font-mono">· {p.config.permission_mode}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right form */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {!draft ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-slate-500">Select a profile on the left, or click <kbd className="px-1 border border-slate-700 rounded text-[10px]">+</kbd> to create one.</p>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-3 max-w-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">
                {selectedId ? 'Edit profile' : 'New profile'}
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

            {/* Name + description */}
            <Field label="Name">
              <input
                type="text"
                value={draft.name}
                onChange={e => patch({ name: e.target.value })}
                placeholder="e.g. Claude Sonnet — plan only"
                className={inputCls}
              />
            </Field>
            <Field label="Description" help="Optional. Shown in the profile list.">
              <textarea
                value={draft.description || ''}
                onChange={e => patch({ description: e.target.value })}
                rows={2}
                className={cn(inputCls, 'resize-y')}
              />
            </Field>

            {/* Agent type */}
            <Field label="Agent type">
              <select
                value={draft.agent_type}
                onChange={e => patch({ agent_type: e.target.value as ProfileAgentType })}
                className={inputCls}
              >
                <option value="claude-code">claude-code (external CLI)</option>
                <option value="cursor-cli">cursor-cli (external CLI)</option>
                <option value="internal">internal (Oasis chat LLM)</option>
              </select>
              {isInternal && (
                <p className="text-[10px] text-amber-400/80 mt-1">
                  Internal profiles can be defined and bound to roles, but spawning them is not wired yet — external profiles work today.
                </p>
              )}
            </Field>

            {/* Model */}
            <Field
              label="Model"
              help={
                isInternal
                  ? 'LLM model name (e.g. llama3.2, gpt-5).'
                  : 'Passed as --model to the CLI (e.g. sonnet, opus, gpt-5).'
              }
            >
              <input
                type="text"
                value={draft.config.model || ''}
                onChange={e => patchCfg({ model: e.target.value })}
                placeholder={isInternal ? 'llama3.2' : 'sonnet'}
                className={inputCls}
              />
            </Field>

            {/* Internal-only: provider */}
            {isInternal && (
              <Field label="Provider">
                <select
                  value={draft.config.provider || ''}
                  onChange={e => patchCfg({ provider: (e.target.value || undefined) as any })}
                  className={inputCls}
                >
                  <option value="">(default)</option>
                  <option value="ollama">ollama</option>
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                </select>
              </Field>
            )}

            {/* External-only: permission mode + mcp */}
            {isExternal && (
              <>
                <Field label="Permission mode">
                  <select
                    value={draft.config.permission_mode || 'acceptEdits'}
                    onChange={e => patchCfg({ permission_mode: e.target.value as PermissionMode })}
                    className={inputCls}
                  >
                    <option value="plan">plan (read-only)</option>
                    <option value="acceptEdits">acceptEdits (auto-edit inside worktree) — default</option>
                    <option value="bypassPermissions">bypassPermissions (dangerous)</option>
                    <option value="default">default (interactive prompts)</option>
                  </select>
                </Field>
                <Field label="MCP loopback" help="Wires the Oasis MCP server so the child can call Oasis tools back. (cursor-cli ignores this — register globally via `cursor-agent mcp enable oasis` instead.)">
                  <button
                    type="button"
                    onClick={() => patchCfg({ mcp_enabled: !draft.config.mcp_enabled })}
                    className={cn(
                      'inline-flex items-center gap-1.5 self-start px-2 py-1 rounded border text-[11px]',
                      draft.config.mcp_enabled
                        ? 'bg-emerald-900/30 border-emerald-800/50 text-emerald-300'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400',
                    )}
                  >
                    <span className={cn(
                      'inline-block w-3 h-3 rounded-full transition-colors',
                      draft.config.mcp_enabled ? 'bg-emerald-400' : 'bg-slate-600',
                    )} />
                    {draft.config.mcp_enabled ? 'on' : 'off'}
                  </button>
                </Field>
              </>
            )}

            {/* Preamble */}
            <Field label="System prompt preamble" help="Prepended to every spawn's prompt (claude-code via --append-system-prompt; cursor-cli via a [Role context] header in the prompt body).">
              <textarea
                value={draft.config.system_prompt_preamble || ''}
                onChange={e => patchCfg({ system_prompt_preamble: e.target.value })}
                rows={4}
                placeholder="You are …"
                className={cn(inputCls, 'resize-y font-mono')}
              />
            </Field>

            {/* Extra args — external only */}
            {isExternal && (
              <Field label="Extra CLI args" help="Raw strings appended to every spawn's argv. Example: --effort high">
                <ArrayEditor
                  value={draft.config.extra_args || []}
                  onChange={v => patchCfg({ extra_args: v })}
                />
              </Field>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Small presentational helpers ─────────────────────────────── */

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

function TypeIcon({ t }: { t: ProfileAgentType }) {
  if (t === 'internal') return <ScrollText className="w-3 h-3 text-sky-400" />;
  if (t === 'claude-code') return <Sparkles className="w-3 h-3 text-amber-400" />;
  return <Boxes className="w-3 h-3 text-purple-400" />;
}

function ArrayEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {value.length === 0 && <p className="text-[10px] text-slate-500 italic">No extra args.</p>}
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            type="text"
            value={item}
            onChange={e => {
              const next = [...value]; next[i] = e.target.value; onChange(next);
            }}
            className={cn(inputCls, 'font-mono')}
          />
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0 text-slate-500 hover:text-red-400" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X className="w-3 h-3" />
          </Button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, ''])}
        className="self-start inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300"
      >
        <Plus className="w-3 h-3" /> Add arg
      </button>
    </div>
  );
}

// Avoid unused-import warning for icons
void CheckCircle2;
