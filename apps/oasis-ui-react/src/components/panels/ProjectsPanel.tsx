import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, FolderOpen, Plus, Trash2, Loader2,
  Star, ExternalLink, Settings,
  HardDrive, Globe, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';
import {
  listProjects, createProject, deleteProject, activateProject,
  getProjectSettings, saveProjectSettings, updateProject,
  type Project,
} from '@/lib/artifact-api';

interface ProjectsPanelProps {
  open: boolean;
  onClose: () => void;
  activeProjectId?: string;
  onActiveProjectChange?: (projectId: string | undefined) => void;
}

export function ProjectsPanel({
  open,
  onClose,
  activeProjectId,
  onActiveProjectChange,
}: ProjectsPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPath, setNewPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedSettingsId, setExpandedSettingsId] = useState<string | null>(null);
  // Per-project code index settings — keyed by project ID so each project's
  // path/type/gitUrl stays with the project it belongs to.
  const [projectSettings, setProjectSettings] = useState<Record<string, { projectPath: string; projectType: 'local' | 'git'; gitUrl: string }>>({});
  // Per-project indexing state (only one project has settings expanded at a time,
  // but using per-project keys avoids stale cross-contamination)
  const [isIndexingByProject, setIsIndexingByProject] = useState<Record<string, boolean>>({});
  const [indexErrorByProject, setIndexErrorByProject] = useState<Record<string, string>>({});

  async function pickFolder(setPath: (p: string) => void): Promise<void> {
    try {
      const handle = await (window as unknown as { showDirectoryPicker(opts: { mode: string }): Promise<{ name: string }> }).showDirectoryPicker({ mode: 'read' });
      setPath(handle.name);
      return;
    } catch { /* user cancelled or API unavailable */ }
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProjects();
      setProjects(list);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const p = await createProject(newName.trim(), newDesc.trim() || undefined, newPath.trim() || undefined);
      setNewName(''); setNewDesc(''); setNewPath('');
      setShowCreate(false);
      onActiveProjectChange?.(p.project_id);
      await refresh();
    } catch { /* ignore */ }
    setCreating(false);
  };

  const handleSelect = async (id: string) => {
    onActiveProjectChange?.(id);
    try {
      await activateProject(id);
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteProject(id);
      if (id === activeProjectId) onActiveProjectChange?.(undefined);
      await refresh();
    } catch { /* ignore */ }
  };

  const handleExpandSettings = useCallback(async (projectId: string) => {
    if (expandedSettingsId === projectId) {
      setExpandedSettingsId(null);
      return;
    }
    setExpandedSettingsId(projectId);
    // Load per-project settings
    let path = '';
    let type: 'local' | 'git' = 'local';
    let git = '';
    try {
      const { settings } = await getProjectSettings(projectId);
      if (settings) {
        path = settings.project_path || '';
        type = settings.project_type || 'local';
        git = settings.git_url || '';
      }
    } catch { /* use defaults */ }
    setProjectSettings(prev => ({ ...prev, [projectId]: { projectPath: path, projectType: type, gitUrl: git } }));
    setIndexErrorByProject(prev => ({ ...prev, [projectId]: '' }));
  }, [expandedSettingsId]);

  const getSettings = (projectId: string) => projectSettings[projectId] || { projectPath: '', projectType: 'local' as const, gitUrl: '' };

  const updateProjectSetting = (projectId: string, upd: Partial<{ projectPath: string; projectType: 'local' | 'git'; gitUrl: string }>) => {
    setProjectSettings(prev => {
      const cur = prev[projectId] || { projectPath: '', projectType: 'local' as const, gitUrl: '' };
      return { ...prev, [projectId]: { ...cur, ...upd } };
    });
  };

  const handleConfigureIndex = async (projectId: string) => {
    setIsIndexingByProject(prev => ({ ...prev, [projectId]: true }));
    setIndexErrorByProject(prev => ({ ...prev, [projectId]: '' }));
    const s = getSettings(projectId);
    try {
      const body: Record<string, string> = { project_path: s.projectPath, project_type: s.projectType };
      if (projectId) body.project_id = projectId;
      if (s.projectType === 'git' && s.gitUrl) body.git_url = s.gitUrl;
      await axios.post(`${OASIS_BASE_URL}/api/v1/project/configure`, body, { timeout: 60000 });
      // Save path + settings to the project node
      if (s.projectPath) {
        await updateProject(projectId, { project_path: s.projectPath });
        await saveProjectSettings(projectId, {
          project_path: s.projectPath,
          project_type: s.projectType,
          git_url: s.gitUrl || '',
        });
      }
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'response' in err
        ? String((err as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Failed to configure')
        : String(err);
      setIndexErrorByProject(prev => ({ ...prev, [projectId]: msg }));
    } finally { setIsIndexingByProject(prev => ({ ...prev, [projectId]: false })); }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 320 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 320 }}
      transition={{ type: 'spring', damping: 28, stiffness: 300 }}
      className="fixed right-0 top-0 h-full w-80 max-w-[90vw] z-40 flex flex-col bg-[#0a0f1a] border-l border-slate-800 shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <FolderOpen className="w-4 h-4 text-blue-400" />
          <h2 className="text-sm font-bold text-slate-100">Projects</h2>
          {loading && <Loader2 className="w-3 h-3 text-slate-500 animate-spin" />}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-blue-400"
            onClick={() => setShowCreate(v => !v)}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            New
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
            title="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Create form */}
        <AnimatePresence>
          {showCreate && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-b border-slate-800"
            >
              <div className="p-4 space-y-2.5">
                <Input
                  placeholder="Project name *"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="text-xs h-8"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                />
                <Input
                  placeholder="Description (optional)"
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  className="text-xs h-8"
                />
                <div>
                  <div className="flex gap-1.5">
                    <Input
                      placeholder="Source location (optional)"
                      value={newPath}
                      onChange={e => setNewPath(e.target.value)}
                      className="text-xs h-8 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => pickFolder(setNewPath)}
                      className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/50 text-slate-400 hover:text-white transition-all text-[11px] font-medium"
                      title="Browse folders (Finder)"
                    >
                      Browse
                    </button>
                  </div>
                  <p className="text-[9px] text-slate-600 mt-1">
                    Path to the project directory on the host machine
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="text-xs h-7 flex-1"
                    onClick={handleCreate}
                    disabled={creating || !newName.trim()}
                  >
                    {creating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
                    Create
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Project list */}
        <div className="py-2">
          {projects.length === 0 && !loading && (
            <div className="px-5 py-8 text-center">
              <FolderOpen className="w-8 h-8 text-slate-700 mx-auto mb-3" />
              <p className="text-xs text-slate-500 mb-4">No projects yet</p>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setShowCreate(true)}
              >
                <Plus className="w-3 h-3 mr-1" /> Create your first project
              </Button>
            </div>
          )}
          {projects.map(p => {
            const s = getSettings(p.project_id);
            return (
            <div key={p.project_id}>
            <button
              type="button"
              className={cn(
                'w-full text-left px-5 py-3 hover:bg-slate-800/40 transition-colors flex items-start gap-3 border-b border-slate-800/30',
                activeProjectId === p.project_id && 'bg-blue-900/15',
              )}
              onClick={() => handleSelect(p.project_id)}
            >
              <div className="mt-0.5 shrink-0">
                {activeProjectId === p.project_id ? (
                  <Star className="w-4 h-4 text-blue-400 fill-blue-400" />
                ) : (
                  <FolderOpen className="w-4 h-4 text-slate-500" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-sm font-medium truncate',
                    activeProjectId === p.project_id ? 'text-blue-300' : 'text-slate-200',
                  )}>
                    {p.name}
                  </span>
                  {activeProjectId === p.project_id && (
                    <span className="text-[9px] text-blue-400 font-medium bg-blue-900/30 px-1.5 py-0.5 rounded">Active</span>
                  )}
                </div>
                {p.description && (
                  <p className="text-[11px] text-slate-500 mt-0.5 truncate">{p.description}</p>
                )}
                {p.project_path && (
                  <p className="text-[10px] text-slate-600 font-mono mt-0.5 truncate flex items-center gap-1">
                    <ExternalLink className="w-2.5 h-2.5" />
                    {p.project_path}
                  </p>
                )}
                <div className="flex gap-2 mt-1 text-[10px] text-slate-600">
                  {p.artifact_count != null && <span>{p.artifact_count} artifacts</span>}
                  {p.chat_count != null && <span>{p.chat_count} chats</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); handleExpandSettings(p.project_id); }}
                className="p-1 rounded text-slate-600 hover:text-white hover:bg-slate-700/50 transition-all shrink-0 mt-0.5"
                title="Code Index settings"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={e => handleDelete(p.project_id, e)}
                className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-red-950/30 transition-all shrink-0 mt-0.5"
                title="Delete project"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </button>
            {/* ── Expandable Code Index settings ───────────────── */}
            <AnimatePresence>
              {expandedSettingsId === p.project_id && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-b border-slate-800"
                >
                  <div className="px-5 py-3 bg-slate-900/40 space-y-3">
                    <h4 className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">Code Index</h4>
                    <div>
                      <label className="text-[10px] text-slate-500 font-medium mb-1 block">Source</label>
                      <div className="flex gap-2">
                        <button className={cn("flex-1 flex items-center justify-center gap-2 py-1.5 rounded-lg text-xs font-medium transition-all", s.projectType === 'local' ? "bg-blue-600/20 border border-blue-500/30 text-blue-400" : "bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-slate-300")} onClick={() => updateProjectSetting(p.project_id, { projectType: 'local' })}>
                          <HardDrive className="w-3 h-3" /> Local
                        </button>
                        <button className={cn("flex-1 flex items-center justify-center gap-2 py-1.5 rounded-lg text-xs font-medium transition-all", s.projectType === 'git' ? "bg-blue-600/20 border border-blue-500/30 text-blue-400" : "bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-slate-300")} onClick={() => updateProjectSetting(p.project_id, { projectType: 'git' })}>
                          <Globe className="w-3 h-3" /> Git
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-medium mb-1 block">{s.projectType === 'local' ? 'Project Path' : 'Local Clone Path'}</label>
                      <div className="flex gap-1.5">
                        <input type="text" value={s.projectPath} onChange={e => updateProjectSetting(p.project_id, { projectPath: e.target.value })} placeholder="/Users/you/your-project" className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/50 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500/50" />
                        <button
                          type="button"
                          onClick={() => pickFolder((val: string) => updateProjectSetting(p.project_id, { projectPath: val }))}
                          className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/50 text-slate-400 hover:text-white transition-all text-[11px] font-medium"
                          title="Browse folders (Finder)"
                        >
                          Browse
                        </button>
                      </div>
                    </div>
                    {s.projectType === 'git' && (
                      <div>
                        <label className="text-[10px] text-slate-500 font-medium mb-1 block">Git URL</label>
                        <input type="text" value={s.gitUrl} onChange={e => updateProjectSetting(p.project_id, { gitUrl: e.target.value })} placeholder="https://github.com/user/repo.git" className="w-full px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/50 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500/50" />
                      </div>
                    )}
                    <button onClick={() => handleConfigureIndex(p.project_id)} disabled={isIndexingByProject[p.project_id] || !s.projectPath.trim()} className={cn("w-full py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2", isIndexingByProject[p.project_id] ? "bg-slate-800 text-slate-400 cursor-wait" : "bg-blue-600 hover:bg-blue-500 text-white")}>
                      {isIndexingByProject[p.project_id] ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" />Indexing...</>) : (<><RefreshCw className="w-3.5 h-3.5" />Configure &amp; Index</>)}
                    </button>
                    {indexErrorByProject[p.project_id] && <p className="text-xs text-red-400">{indexErrorByProject[p.project_id]}</p>}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
