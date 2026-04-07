import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, FolderOpen, RefreshCw, Loader2, CheckCircle2,
  HardDrive, Globe, RotateCcw,
  Trash2, FileText,
  ChevronDown, Plus, Edit2, Check, Mic,
  MessageSquare, Link2, Unlink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { LanguageSettings } from '@/components/ui/language-settings';
import { OASIS_BASE_URL } from '@/lib/constants';
import type { ProjectConfig } from '@/lib/types';
import {
  listArtifacts,
  createProject, listProjects, getProject, updateProject, deleteProject,
  linkChatToProject, unlinkChatFromProject,
  unlinkArtifactFromProject,
  listSpeakers, enrollSpeaker, updateSpeaker, deleteSpeaker,
  activateProject, getProjectSettings, saveProjectSettings,
  type Artifact, type Project, type SpeakerProfile,
} from '@/lib/artifact-api';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  projectConfig: ProjectConfig;
  onProjectConfigured: (config: ProjectConfig) => void;
  sessionId: string;
  autonomousMode: boolean;
  onAutonomousModeChange: (enabled: boolean) => void;
  activeProjectId?: string;
  onActiveProjectChange?: (projectId: string | undefined) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

const AUDIO_EXTS = ['.m4a', '.mp3', '.wav', '.ogg', '.aac', '.flac', '.wma', '.webm'];

function inferMediaType(mime: string, name: string): 'audio' | 'video' | 'image' | null {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  const ext = name.toLowerCase().replace(/.*(\.[^.]+)$/, '$1');
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
}

type TabKey = 'project' | 'voices' | 'autonomous' | 'general';

export function SettingsPanel({
  open, onClose, projectConfig, onProjectConfigured, sessionId,
  autonomousMode, onAutonomousModeChange,
  activeProjectId, onActiveProjectChange,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<TabKey>('project');

  // ── Code index config ────────────────────────────────────────────────
  const [projectPath, setProjectPath] = useState(projectConfig.project_path || '');
  const [projectType, setProjectType] = useState<'local' | 'git'>(projectConfig.project_type || 'local');
  const [gitUrl, setGitUrl] = useState(projectConfig.git_url || '');
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexError, setIndexError] = useState('');
  // Track whether per-project settings have been loaded (to avoid overwriting with stale prop)
  const [projectSettingsLoaded, setProjectSettingsLoaded] = useState(false);

  // ── Autonomous ───────────────────────────────────────────────────────
  const [autonomousMaxHours, setAutonomousMaxHours] = useState(() => parseInt(localStorage.getItem('oasis_autonomous_max_hours') || '6', 10));
  const [snapshots, setSnapshots] = useState<Array<{ snapshot_id: string; timestamp: string; iteration_count: number }>>([]);
  const [restoringSnapshot, setRestoringSnapshot] = useState(false);

  // ── Artifacts (minimal – for Voices tab speaker enrollment) ──────────
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  // ── Project management (inside Project tab) ──────────────────────────
  const [oasisProjects, setOasisProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [activeProjectDetail, setActiveProjectDetail] = useState<Project | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [editName, setEditName] = useState('');
  const [showProjectPicker, setShowProjectPicker] = useState(false);

  // ── Speakers (Voice ID) ─────────────────────────────────────────────
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([]);
  const [speakersLoading, setSpeakersLoading] = useState(false);
  const [enrollArtifactId, setEnrollArtifactId] = useState('');
  const [enrollName, setEnrollName] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [editSpeakerName, setEditSpeakerName] = useState('');

  // ── Data loading ─────────────────────────────────────────────────────

  useEffect(() => {
    if (open && tab === 'autonomous' && sessionId) {
      axios.get(`${OASIS_BASE_URL}/api/v1/dev-agent/snapshots`, { params: { session_id: sessionId } })
        .then(res => setSnapshots(res.data?.snapshots || []))
        .catch(() => setSnapshots([]));
    }
  }, [open, tab, sessionId]);

  const refreshArtifacts = useCallback(async () => {
    try { setArtifacts(await listArtifacts()); } catch { /* ignore */ }
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    try { setOasisProjects(await listProjects()); } catch { /* ignore */ }
    setProjectsLoading(false);
  }, []);

  const refreshActiveProject = useCallback(async () => {
    if (!activeProjectId) { setActiveProjectDetail(null); return; }
    try { setActiveProjectDetail(await getProject(activeProjectId)); } catch { setActiveProjectDetail(null); }
  }, [activeProjectId]);

  useEffect(() => {
    if (open && tab === 'project') {
      refreshProjects();
      refreshActiveProject();
      // Load per-project settings into the form when opening the project tab
      if (activeProjectId) {
        getProjectSettings(activeProjectId)
          .then(({ settings }) => {
            if (settings) {
              if (settings.project_path) setProjectPath(settings.project_path);
              if (settings.project_type) setProjectType(settings.project_type);
              if (settings.git_url !== undefined) setGitUrl(settings.git_url || '');
              setProjectSettingsLoaded(true);
            }
          })
          .catch(() => { /* ignore */ });
      } else {
        setProjectSettingsLoaded(false);
      }
    }
  }, [open, tab, refreshProjects, refreshActiveProject, activeProjectId]);

  // Sync from projectConfig prop when it changes (e.g. after App fetches /project/config)
  // but only if per-project settings haven't been loaded yet
  useEffect(() => {
    if (!projectSettingsLoaded && projectConfig.project_path) {
      setProjectPath(projectConfig.project_path);
    }
    if (!projectSettingsLoaded && projectConfig.project_type) {
      setProjectType(projectConfig.project_type);
    }
    if (!projectSettingsLoaded && projectConfig.git_url !== undefined) {
      setGitUrl(projectConfig.git_url || '');
    }
  }, [projectConfig, projectSettingsLoaded]);

  // ── Speaker data loading ────────────────────────────────────────────
  const refreshSpeakers = useCallback(async () => {
    setSpeakersLoading(true);
    try { setSpeakers(await listSpeakers()); } catch { /* ignore */ }
    setSpeakersLoading(false);
  }, []);

  useEffect(() => {
    if (open && tab === 'voices') { refreshSpeakers(); refreshArtifacts(); }
  }, [open, tab, refreshSpeakers, refreshArtifacts]);

  // ── Code index handlers ──────────────────────────────────────────────

  const handleConfigure = async () => {
    setIsIndexing(true); setIndexError('');
    try {
      const body: Record<string, string> = { project_path: projectPath, project_type: projectType };
      if (activeProjectId) body.project_id = activeProjectId;
      if (projectType === 'git' && gitUrl) body.git_url = gitUrl;
      const res = await axios.post(`${OASIS_BASE_URL}/api/v1/project/configure`, body, { timeout: 60000 });
      const d = res.data;
      onProjectConfigured({ configured: true, project_path: d.config?.project_path, project_name: d.config?.project_name, project_type: d.config?.project_type, git_url: d.config?.git_url, last_indexed: d.config?.last_indexed, context_summary: d.config?.context_summary, tech_stack: d.index?.tech_stack, frameworks: d.index?.frameworks });
      // Save project_path on the active project node + persist per-project settings
      if (activeProjectId && projectPath) {
        await updateProject(activeProjectId, { project_path: projectPath });
        // Save code index config as per-project settings so they're remembered
        await saveProjectSettings(activeProjectId, {
          project_path: projectPath,
          project_type: projectType,
          git_url: gitUrl || '',
        });
      }
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'response' in err ? String((err as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Failed to configure project') : String(err);
      setIndexError(msg);
    } finally { setIsIndexing(false); }
  };

  const handleReindex = async () => {
    setIsIndexing(true); setIndexError('');
    try { const res = await axios.post(`${OASIS_BASE_URL}/api/v1/project/reindex`, {}, { timeout: 60000 }); onProjectConfigured(res.data); }
    catch { setIndexError('Failed to reindex'); } finally { setIsIndexing(false); }
  };

  // ── Autonomous handlers ──────────────────────────────────────────────

  const handleAutonomousToggle = (enabled: boolean) => onAutonomousModeChange(enabled);
  const handleAutonomousMaxHoursChange = (hours: number) => {
    setAutonomousMaxHours(hours);
    localStorage.setItem('oasis_autonomous_max_hours', String(hours));
  };
  const handleRestoreSnapshot = async (snapshotId: string) => {
    setRestoringSnapshot(true);
    try { await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/snapshots/restore`, { snapshot_id: snapshotId, session_id: sessionId }); }
    catch { /* ignore */ } finally { setRestoringSnapshot(false); }
  };

  // ── Project management handlers ──────────────────────────────────────

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    const p = await createProject(newProjectName, newProjectDesc);
    setNewProjectName(''); setNewProjectDesc(''); setShowCreateProject(false);
    onActiveProjectChange?.(p.project_id);
    // New project has no settings yet — clear the code index form
    setProjectPath('');
    setProjectType('local');
    setGitUrl('');
    setProjectSettingsLoaded(true); // prevent stale prop from overwriting
    await refreshProjects();
    await refreshActiveProject();
  };

  const handleSelectProject = async (id: string | undefined) => {
    onActiveProjectChange?.(id);
    setShowProjectPicker(false);
    setProjectSettingsLoaded(false);
    // Activate on the backend so PROJECT_ROOT and settings are applied
    try {
      await activateProject(id ?? null);
    } catch { /* ignore if dev-agent is down */ }
    // Load per-project settings into the form
    if (id) {
      try {
        const { settings } = await getProjectSettings(id);
        if (settings) {
          if (settings.project_path) setProjectPath(settings.project_path);
          if (settings.project_type) setProjectType(settings.project_type);
          if (settings.git_url !== undefined) setGitUrl(settings.git_url || '');
          setProjectSettingsLoaded(true);
        }
      } catch { /* ignore */ }
    } else {
      // Deactivated — reset to global config
      setProjectPath(projectConfig.project_path || '');
      setProjectType(projectConfig.project_type || 'local');
      setGitUrl(projectConfig.git_url || '');
    }
  };

  const handleUpdateProjectName = async () => {
    if (!editName.trim() || !activeProjectId) return;
    await updateProject(activeProjectId, { name: editName });
    setEditingProjectName(false);
    await refreshActiveProject();
    await refreshProjects();
  };

  const handleDeleteProject = async () => {
    if (!activeProjectId) return;
    await deleteProject(activeProjectId);
    onActiveProjectChange?.(undefined);
    await refreshProjects();
  };

  const handleLinkChat = async () => {
    if (!activeProjectId) return;
    await linkChatToProject(activeProjectId, sessionId);
    await refreshActiveProject();
  };

  const handleUnlinkChat = async (sid: string) => {
    if (!activeProjectId) return;
    await unlinkChatFromProject(activeProjectId, sid);
    await refreshActiveProject();
  };

  const handleUnlinkArtifact = async (artifactId: string) => {
    if (!activeProjectId) return;
    await unlinkArtifactFromProject(activeProjectId, artifactId);
    await refreshActiveProject();
  };

  // ── Speaker handlers ─────────────────────────────────────────────────

  const handleEnrollSpeaker = async () => {
    if (!enrollArtifactId || !enrollName.trim()) return;
    setEnrolling(true);
    try {
      await enrollSpeaker(enrollArtifactId, enrollName.trim());
      setEnrollArtifactId(''); setEnrollName('');
      await refreshSpeakers();
    } catch (err: any) { console.error('Enroll speaker failed:', err); }
    setEnrolling(false);
  };

  const handleUpdateSpeakerName = async (id: string) => {
    if (!editSpeakerName.trim()) return;
    try {
      await updateSpeaker(id, { name: editSpeakerName.trim() });
      setEditingSpeakerId(null);
      await refreshSpeakers();
    } catch { /* ignore */ }
  };

  const handleDeleteSpeaker = async (id: string) => {
    try { await deleteSpeaker(id); setSpeakers(prev => prev.filter(s => s.speaker_id !== id)); } catch { /* ignore */ }
  };

  if (!open) return null;

  const activeProjectName = activeProjectDetail?.name || oasisProjects.find(p => p.project_id === activeProjectId)?.name;

  return (<>
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 400, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="border-r border-slate-800 bg-[#0a0f1a] overflow-hidden flex flex-col"
    >
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">Settings</h2>
        <Button variant="ghost" size="icon" className="w-6 h-6 text-slate-500 hover:text-white" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 overflow-x-auto">
        {([
          ['project', 'Project'],
          ['voices', 'Voices'],
          ['autonomous', 'Autonomous'],
          ['general', 'General'],
        ] as [TabKey, string][]).map(([key, label]) => (
          <button
            key={key}
            className={cn(
              "flex-shrink-0 px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap",
              tab === key ? "text-blue-400 border-b-2 border-blue-400" : "text-slate-500 hover:text-slate-300"
            )}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* ════════════════════════════════════════════════════════════ */}
          {/* ── PROJECT TAB ─────────────────────────────────────────── */}
          {/* ════════════════════════════════════════════════════════════ */}
          {tab === 'project' && (
            <div className="flex flex-col gap-4">

              {/* ── Project Switcher ────────────────────────────────── */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-400 font-medium">Active Project</label>
                {activeProjectId && activeProjectName ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-blue-900/15 border border-blue-800/25">
                    <FolderOpen className="w-4 h-4 text-blue-400 shrink-0" />
                    {editingProjectName ? (
                      <div className="flex-1 flex gap-1">
                        <Input value={editName} onChange={e => setEditName(e.target.value)} className="text-xs h-7 flex-1" autoFocus onKeyDown={e => e.key === 'Enter' && handleUpdateProjectName()} />
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleUpdateProjectName}><Check className="h-3 w-3 text-green-400" /></Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditingProjectName(false)}><X className="h-3 w-3 text-slate-500" /></Button>
                      </div>
                    ) : (
                      <>
                        <span className="flex-1 text-sm font-medium text-blue-300 truncate">{activeProjectName}</span>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => { setEditingProjectName(true); setEditName(activeProjectName); }} title="Rename">
                          <Edit2 className="h-3 w-3 text-slate-500" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setShowProjectPicker(v => !v)} title="Switch project">
                          <ChevronDown className={cn("h-3 w-3 text-slate-500 transition-transform", showProjectPicker && "rotate-180")} />
                        </Button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-900/50 border border-slate-800">
                    <FolderOpen className="w-4 h-4 text-slate-500 shrink-0" />
                    <span className="flex-1 text-xs text-slate-500">No project selected</span>
                    <Button variant="ghost" size="sm" className="h-6 text-xs text-blue-400" onClick={() => setShowProjectPicker(v => !v)}>
                      Select
                    </Button>
                  </div>
                )}

                {/* Project picker dropdown */}
                <AnimatePresence>
                  {showProjectPicker && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="rounded-lg border border-slate-800 bg-slate-900/80 max-h-48 overflow-y-auto">
                        {activeProjectId && (
                          <button className="w-full text-left px-3 py-2 text-xs text-slate-400 hover:bg-slate-800/50 border-b border-slate-800" onClick={() => handleSelectProject(undefined)}>
                            Clear selection
                          </button>
                        )}
                        {projectsLoading && <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-slate-500" /></div>}
                        {oasisProjects.map(p => (
                          <button
                            key={p.project_id}
                            className={cn("w-full text-left px-3 py-2 text-xs hover:bg-slate-800/50 flex items-center gap-2", activeProjectId === p.project_id && "bg-blue-900/20 text-blue-400")}
                            onClick={() => handleSelectProject(p.project_id)}
                          >
                            <FolderOpen className="h-3 w-3 shrink-0" />
                            <span className="flex-1 truncate">{p.name}</span>
                            <span className="text-[10px] text-slate-600">
                              {[p.artifact_count && `${p.artifact_count}a`, p.chat_count && `${p.chat_count}c`, p.repo_count && `${p.repo_count}r`].filter(Boolean).join(' ')}
                            </span>
                          </button>
                        ))}
                        <button className="w-full text-left px-3 py-2 text-xs text-blue-400 hover:bg-slate-800/50 flex items-center gap-2 border-t border-slate-800" onClick={() => { setShowProjectPicker(false); setShowCreateProject(true); }}>
                          <Plus className="h-3 w-3" /> Create new project
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Create project form */}
                <AnimatePresence>
                  {showCreateProject && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="rounded-lg border border-slate-800 p-3 flex flex-col gap-2">
                        <Input placeholder="Project name..." value={newProjectName} onChange={e => setNewProjectName(e.target.value)} className="text-xs h-8" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreateProject()} />
                        <Input placeholder="Description (optional)..." value={newProjectDesc} onChange={e => setNewProjectDesc(e.target.value)} className="text-xs h-8" />
                        <div className="flex gap-2">
                          <Button size="sm" className="text-xs h-7 flex-1" onClick={handleCreateProject}>Create</Button>
                          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setShowCreateProject(false)}>Cancel</Button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* ── Active Project Details ──────────────────────────── */}
              {activeProjectId && activeProjectDetail && (
                <div className="flex flex-col gap-3">
                  {activeProjectDetail.description && (
                    <p className="text-xs text-slate-400">{activeProjectDetail.description}</p>
                  )}

                  {/* Linked Artifacts */}
                  <div>
                    <h4 className="text-[10px] text-slate-500 uppercase mb-1.5 flex items-center gap-1">
                      <FileText className="h-3 w-3" /> Linked Artifacts
                    </h4>
                    {activeProjectDetail.artifacts?.length ? (
                      <div className="flex flex-col gap-0.5">
                        {activeProjectDetail.artifacts.map((a: any) => (
                          <div key={a.artifact_id} className="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-800/30">
                            <span className="text-xs text-slate-300 truncate">{a.name}</span>
                            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => handleUnlinkArtifact(a.artifact_id)}>
                              <Unlink className="h-2.5 w-2.5 text-slate-500" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-[11px] text-slate-600 pl-1">No artifacts — upload from the Artifacts tab</p>}
                  </div>

                  {/* Linked Chats */}
                  <div>
                    <h4 className="text-[10px] text-slate-500 uppercase mb-1.5 flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" /> Linked Chats
                    </h4>
                    {activeProjectDetail.chats?.length ? (
                      <div className="flex flex-col gap-0.5">
                        {activeProjectDetail.chats.map((c: any) => (
                          <div key={c.session_id} className="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-800/30">
                            <span className="text-[10px] text-slate-300 truncate font-mono">{c.session_id}</span>
                            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => handleUnlinkChat(c.session_id)}>
                              <Unlink className="h-2.5 w-2.5 text-slate-500" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-[11px] text-slate-600 pl-1">No chats linked</p>}
                    <Button variant="outline" size="sm" className="text-[10px] h-6 mt-1.5" onClick={handleLinkChat}>
                      <Link2 className="h-2.5 w-2.5 mr-1" /> Link current chat
                    </Button>
                  </div>

                  {/* Danger zone */}
                  <div className="pt-2 border-t border-slate-800">
                    <Button variant="ghost" size="sm" className="text-[10px] h-6 text-red-400 hover:text-red-300" onClick={handleDeleteProject}>
                      <Trash2 className="h-3 w-3 mr-1" /> Delete project
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Code Index Config ───────────────────────────────── */}
              <div className="pt-3 border-t border-slate-800">
                <h3 className="text-xs text-slate-400 font-medium mb-3">Code Index</h3>
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="text-[10px] text-slate-500 font-medium mb-1 block">Source</label>
                    <div className="flex gap-2">
                      <button className={cn("flex-1 flex items-center justify-center gap-2 py-1.5 rounded-lg text-xs font-medium transition-all", projectType === 'local' ? "bg-blue-600/20 border border-blue-500/30 text-blue-400" : "bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-slate-300")} onClick={() => setProjectType('local')}>
                        <HardDrive className="w-3 h-3" /> Local
                      </button>
                      <button className={cn("flex-1 flex items-center justify-center gap-2 py-1.5 rounded-lg text-xs font-medium transition-all", projectType === 'git' ? "bg-blue-600/20 border border-blue-500/30 text-blue-400" : "bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-slate-300")} onClick={() => setProjectType('git')}>
                        <Globe className="w-3 h-3" /> Git
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 font-medium mb-1 block">{projectType === 'local' ? 'Project Path' : 'Local Clone Path'}</label>
                    <input type="text" value={projectPath} onChange={e => setProjectPath(e.target.value)} placeholder="/Users/you/your-project" className="w-full px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/50 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500/50" />
                  </div>
                  {projectType === 'git' && (
                    <div>
                      <label className="text-[10px] text-slate-500 font-medium mb-1 block">Git URL</label>
                      <input type="text" value={gitUrl} onChange={e => setGitUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className="w-full px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/50 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500/50" />
                    </div>
                  )}
                  <button onClick={projectConfig.configured ? handleReindex : handleConfigure} disabled={isIndexing || !projectPath.trim()} className={cn("w-full py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2", isIndexing ? "bg-slate-800 text-slate-400 cursor-wait" : "bg-blue-600 hover:bg-blue-500 text-white")}>
                    {isIndexing ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" />Indexing...</>) : projectConfig.configured ? (<><RefreshCw className="w-3.5 h-3.5" />Re-index</>) : (<><FolderOpen className="w-3.5 h-3.5" />Configure &amp; Index</>)}
                  </button>
                  {indexError && <p className="text-xs text-red-400">{indexError}</p>}
                  {projectConfig.configured && (
                    <div className="p-2.5 rounded-lg bg-slate-900/50 border border-slate-800">
                      <div className="flex items-center gap-2 mb-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                        <span className="text-[11px] font-semibold text-slate-300">{projectConfig.project_name || 'Project'}</span>
                      </div>
                      <p className="text-[10px] text-slate-500 mb-1.5">{projectConfig.project_path}</p>
                      {projectConfig.tech_stack && projectConfig.tech_stack.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {projectConfig.tech_stack.map(t => (<span key={t} className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400">{t}</span>))}
                        </div>
                      )}
                      {projectConfig.frameworks && projectConfig.frameworks.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {projectConfig.frameworks.map(f => (<span key={f} className="px-1.5 py-0.5 rounded bg-blue-900/30 text-[10px] text-blue-400">{f}</span>))}
                        </div>
                      )}
                      {projectConfig.last_indexed && (
                        <p className="text-[10px] text-slate-600">Last indexed: {new Date(projectConfig.last_indexed).toLocaleString()}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════ */}
          {/* ── VOICES TAB ──────────────────────────────────────────── */}
          {/* ════════════════════════════════════════════════════════════ */}
          {tab === 'voices' && (
            <div className="flex flex-col gap-4">
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Voice ID automatically identifies known speakers when processing audio artifacts. Enroll speakers from audio recordings where they are the primary/dominant speaker.
              </p>

              {/* ── Enroll New Speaker ─────────────────────────────── */}
              <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800" onClick={e => e.stopPropagation()}>
                <label className="text-xs text-slate-400 font-medium mb-2 block">Enroll New Speaker</label>
                <div className="flex flex-col gap-2">
                  <select
                    className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs text-slate-300 focus:outline-none focus:border-slate-500"
                    value={enrollArtifactId}
                    onChange={e => setEnrollArtifactId(e.target.value)}
                  >
                    <option value="">Select an audio artifact...</option>
                    {artifacts
                      .filter(a => a.status === 'ready' && (a.mime_type.startsWith('audio/') || inferMediaType(a.mime_type, a.name) === 'audio'))
                      .map(a => (
                        <option key={a.artifact_id} value={a.artifact_id}>{a.name}</option>
                      ))}
                  </select>
                  <Input
                    className="text-xs h-8"
                    placeholder="Speaker name..."
                    value={enrollName}
                    onChange={e => setEnrollName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleEnrollSpeaker()}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-7 self-end"
                    disabled={!enrollArtifactId || !enrollName.trim() || enrolling}
                    onClick={e => { e.stopPropagation(); e.preventDefault(); handleEnrollSpeaker(); }}
                  >
                    {enrolling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Mic className="h-3 w-3 mr-1" />}
                    {enrolling ? 'Enrolling...' : 'Enroll'}
                  </Button>
                </div>
              </div>

              {/* ── Speaker Profiles ──────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-slate-300">Speaker Profiles</span>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={refreshSpeakers} disabled={speakersLoading}>
                    <RefreshCw className={cn("h-3 w-3 text-slate-500", speakersLoading && "animate-spin")} />
                  </Button>
                </div>
                {speakersLoading && speakers.length === 0 ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                  </div>
                ) : speakers.length === 0 ? (
                  <p className="text-[11px] text-slate-500 text-center py-4">No speaker profiles yet. Enroll a speaker from an audio artifact above.</p>
                ) : (
                  <div className="space-y-2">
                    {speakers.map(speaker => {
                      const sourceArtifact = speaker.source_artifact_id
                        ? artifacts.find(a => a.artifact_id === speaker.source_artifact_id)
                        : null;
                      return (
                        <div
                          key={speaker.speaker_id}
                          className="group relative p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition-colors"
                        >
                          <div className="flex items-start gap-2">
                            <Mic className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              {editingSpeakerId === speaker.speaker_id ? (
                                <div className="flex gap-1 items-center">
                                  <Input
                                    value={editSpeakerName}
                                    onChange={e => setEditSpeakerName(e.target.value)}
                                    className="text-xs h-6 flex-1"
                                    autoFocus
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') handleUpdateSpeakerName(speaker.speaker_id);
                                      if (e.key === 'Escape') setEditingSpeakerId(null);
                                    }}
                                  />
                                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleUpdateSpeakerName(speaker.speaker_id)}>
                                    <Check className="h-3 w-3 text-green-400" />
                                  </Button>
                                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setEditingSpeakerId(null)}>
                                    <X className="h-3 w-3 text-slate-500" />
                                  </Button>
                                </div>
                              ) : (
                                <button
                                  className="text-xs font-medium text-slate-200 hover:text-blue-400 transition-colors text-left"
                                  onClick={() => { setEditingSpeakerId(speaker.speaker_id); setEditSpeakerName(speaker.name); }}
                                  title="Click to rename"
                                >
                                  {speaker.name}
                                </button>
                              )}
                              <div className="flex items-center gap-2 mt-0.5">
                                {sourceArtifact && (
                                  <span className="text-[10px] text-slate-500 truncate" title={sourceArtifact.name}>
                                    from: {sourceArtifact.name}
                                  </span>
                                )}
                                <span className="text-[10px] text-slate-600">
                                  {speaker.sample_count} sample{speaker.sample_count !== 1 ? 's' : ''}
                                </span>
                                <span className="text-[10px] text-slate-600">
                                  {new Date(speaker.created_at).toLocaleDateString()}
                                </span>
                              </div>
                            </div>
                            <button
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-900/30"
                              onClick={() => handleDeleteSpeaker(speaker.speaker_id)}
                              title="Delete speaker"
                            >
                              <Trash2 className="h-3 w-3 text-red-400" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════ */}
          {/* ── GENERAL TAB ─────────────────────────────────────────── */}
          {/* ════════════════════════════════════════════════════════════ */}
          {tab === 'general' && (
            <div className="flex flex-col gap-4">
              <LanguageSettings />
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════ */}
          {/* ── AUTONOMOUS TAB ──────────────────────────────────────── */}
          {/* ════════════════════════════════════════════════════════════ */}
          {tab === 'autonomous' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-200">Autonomous Mode</p>
                  <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">Agent self-teaches and iterates until the goal is achieved. Creates snapshots every 5 iterations for safe rollback.</p>
                </div>
                <button
                  className={cn("relative w-12 h-7 rounded-full transition-all duration-200 flex-shrink-0 border", autonomousMode ? "bg-purple-600 border-purple-500 shadow-lg shadow-purple-900/40" : "bg-slate-800 border-slate-600 hover:border-slate-500")}
                  onClick={() => handleAutonomousToggle(!autonomousMode)}
                  role="switch" aria-checked={autonomousMode ? 'true' : 'false'} aria-label="Toggle autonomous mode" title="Toggle autonomous mode"
                >
                  <span className={cn("absolute top-0.5 block w-6 h-6 rounded-full shadow-md transition-all duration-200", autonomousMode ? "left-[22px] bg-white" : "left-0.5 bg-slate-400")} />
                </button>
              </div>
              {autonomousMode && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-950/30 border border-purple-500/20">
                  <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                  <span className="text-[11px] text-purple-300 font-medium">Autonomous mode is active — persists across new chats</span>
                </div>
              )}
              <div>
                <label className="text-xs text-slate-400 font-medium mb-1.5 block">Max duration (hours)</label>
                <input type="number" min={1} max={24} value={autonomousMaxHours} onChange={e => handleAutonomousMaxHoursChange(Math.max(1, Math.min(24, parseInt(e.target.value, 10) || 6)))} className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700/50 text-sm text-slate-200" placeholder="6" title="Max duration in hours (1-24)" aria-label="Max duration in hours" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-xs font-medium text-slate-300">Snapshots (revert points)</span>
                </div>
                {snapshots.length === 0 ? (
                  <p className="text-[11px] text-slate-500">No snapshots yet. Enable autonomous mode and run a task.</p>
                ) : (
                  <div className="space-y-2 max-h-40 overflow-auto">
                    {snapshots.map(s => (
                      <div key={s.snapshot_id} className="flex items-center justify-between p-2 rounded bg-slate-900/50 border border-slate-800">
                        <div>
                          <p className="text-[11px] text-slate-300">Iteration {s.iteration_count}</p>
                          <p className="text-[10px] text-slate-500">{new Date(s.timestamp).toLocaleString()}</p>
                        </div>
                        <Button variant="ghost" size="sm" className="text-xs h-7" disabled={restoringSnapshot} onClick={() => handleRestoreSnapshot(s.snapshot_id)}>Restore</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </motion.div>
    </>
  );
}
