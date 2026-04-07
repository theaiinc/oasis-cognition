import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, QrCode, MessageSquare, Unplug, FolderOpen, Check, Loader2, Clock, Plus, FileStack, FileText, FileAudio, FileImage, Search, ChevronDown, Monitor } from 'lucide-react';
import type { ProjectConfig, ChatSession } from '../../lib/types';

interface ProjectInfo {
  project_id: string;
  project_name: string;
  project_path: string;
  project_type?: string;
  frameworks?: string[];
}

interface ArtifactInfo {
  artifact_id: string;
  name: string;
  mime_type: string;
  status: string;
  file_size: number;
  source_type?: string;
  transcript?: string;
  summary?: string;
}

interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  onScanQR: () => void;
  onDisconnect: () => void;
  paired: boolean;
  tunnelUrl: string | null;
  activeProjectId?: string;
  activeSessionId?: string | null;
  projectConfig: ProjectConfig | null;
  onProjectSwitch: (projectId: string) => void;
  onSessionSelect: (session: ChatSession) => void;
  onNewChat: () => void;
  onOpenComputerUse?: () => void;
}

export function MobileSidebar({
  open,
  onClose,
  onScanQR,
  onDisconnect,
  paired,
  tunnelUrl,
  activeProjectId,
  activeSessionId,
  projectConfig,
  onProjectSwitch,
  onSessionSelect,
  onNewChat,
  onOpenComputerUse,
}: MobileSidebarProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  // Fetch sessions when sidebar opens
  useEffect(() => {
    if (!open || !paired || !tunnelUrl) return;

    setLoadingSessions(true);
    fetch(`${tunnelUrl}/relay/sessions`, { signal: AbortSignal.timeout(10000) })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.sessions && Array.isArray(data.sessions)) {
          setSessions(data.sessions);
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoadingSessions(false));
  }, [open, paired, tunnelUrl]);

  // Fetch artifacts when section is opened
  useEffect(() => {
    if (!showArtifacts || !paired || !tunnelUrl) return;

    setLoadingArtifacts(true);
    fetch(`${tunnelUrl}/relay/artifacts`, { signal: AbortSignal.timeout(10000) })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.artifacts && Array.isArray(data.artifacts)) {
          setArtifacts(data.artifacts);
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoadingArtifacts(false));
  }, [showArtifacts, paired, tunnelUrl]);

  // Fetch projects when project picker is opened
  useEffect(() => {
    if (!showProjects || !paired || !tunnelUrl) return;

    setLoadingProjects(true);
    fetch(`${tunnelUrl}/relay/projects`, { signal: AbortSignal.timeout(10000) })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.success && Array.isArray(data.projects)) {
          // Normalize: memory service returns `name`, mobile UI uses `project_name`
          setProjects(data.projects.map((p: any) => ({
            project_id: p.project_id,
            project_name: p.project_name || p.name || '',
            project_path: p.project_path || '',
            project_type: p.project_type,
            frameworks: p.frameworks,
          })));
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoadingProjects(false));
  }, [showProjects, paired, tunnelUrl]);

  const handleSwitchProject = async (projectId: string) => {
    if (!tunnelUrl || switching) return;
    setSwitching(projectId);
    try {
      const res = await fetch(`${tunnelUrl}/relay/projects/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        onProjectSwitch(projectId);
        setShowProjects(false);
        onClose();
      }
    } catch {
      // ignore
    } finally {
      setSwitching(null);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-40"
            onClick={onClose}
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-0 top-0 bottom-0 w-72 bg-[#0a0f1a] border-r border-slate-800 z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
              <h2 className="text-base font-semibold text-white">Menu</h2>
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Active project indicator */}
            {projectConfig?.configured && projectConfig.project_name && (
              <div className="px-4 py-3 border-b border-slate-800/50">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Active Project</p>
                <p className="text-sm text-white font-medium truncate">{projectConfig.project_name}</p>
                {projectConfig.frameworks && projectConfig.frameworks.length > 0 && (
                  <p className="text-[11px] text-slate-500 truncate">{projectConfig.frameworks.join(', ')}</p>
                )}
              </div>
            )}

            {/* Menu items + sessions */}
            <div className="flex-1 overflow-y-auto flex flex-col">
              <div className="px-3 py-3 flex flex-col gap-1">
                {/* New Chat */}
                <button
                  onClick={() => { onNewChat(); onClose(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                >
                  <Plus className="w-5 h-5 text-cyan-400" />
                  New Chat
                </button>

                {/* Computer Use */}
                {paired && onOpenComputerUse && (
                  <button
                    onClick={() => { onOpenComputerUse(); onClose(); }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  >
                    <Monitor className="w-5 h-5 text-purple-400" />
                    Computer Use
                  </button>
                )}

                <button
                  onClick={() => { onScanQR(); onClose(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                >
                  <QrCode className="w-5 h-5 text-cyan-400" />
                  {paired ? 'Scan New QR Code' : 'Scan QR Code'}
                </button>

                {paired && (
                  <button
                    onClick={() => setShowProjects(prev => !prev)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  >
                    <FolderOpen className="w-5 h-5 text-amber-400" />
                    Switch Project
                    <ChevronDown className={`w-3.5 h-3.5 ml-auto text-slate-500 transition-transform ${showProjects ? 'rotate-180' : ''}`} />
                  </button>
                )}

                {/* Project list — immediately after Switch Project button */}
                <AnimatePresence>
                  {showProjects && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pl-6 pr-1 py-1 flex flex-col gap-0.5">
                        {loadingProjects ? (
                          <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Loading projects...
                          </div>
                        ) : projects.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-slate-500">No projects found</p>
                        ) : (
                          projects.map(p => {
                            const isActive = p.project_id === activeProjectId;
                            const isSwitching = switching === p.project_id;
                            return (
                              <button
                                key={p.project_id}
                                onClick={() => !isActive && handleSwitchProject(p.project_id)}
                                disabled={isActive || !!switching}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs transition-colors ${
                                  isActive
                                    ? 'bg-cyan-900/20 text-cyan-400 border border-cyan-800/30'
                                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                                } ${switching && !isSwitching ? 'opacity-50' : ''}`}
                              >
                                {isSwitching ? (
                                  <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                                ) : isActive ? (
                                  <Check className="w-3 h-3 flex-shrink-0" />
                                ) : (
                                  <div className="w-3 h-3 flex-shrink-0" />
                                )}
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{p.project_name}</p>
                                  {p.frameworks && p.frameworks.length > 0 && (
                                    <p className="text-[10px] text-slate-600 truncate">{p.frameworks[0]}</p>
                                  )}
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {paired && (
                  <button
                    onClick={() => setShowArtifacts(prev => !prev)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  >
                    <FileStack className="w-5 h-5 text-amber-400" />
                    Artifacts
                    <ChevronDown className={`w-3.5 h-3.5 ml-auto text-slate-500 transition-transform ${showArtifacts ? 'rotate-180' : ''}`} />
                  </button>
                )}

                {/* Artifacts list */}
                <AnimatePresence>
                  {showArtifacts && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pl-4 pr-1 py-1 flex flex-col gap-0.5 max-h-64 overflow-y-auto">
                        {loadingArtifacts ? (
                          <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Loading artifacts...
                          </div>
                        ) : artifacts.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-slate-500">No artifacts yet</p>
                        ) : (
                          artifacts.map(a => {
                            const Icon = getArtifactIcon(a.mime_type);
                            const isExpanded = expandedArtifact === a.artifact_id;
                            return (
                              <div key={a.artifact_id}>
                                <button
                                  onClick={() => setExpandedArtifact(isExpanded ? null : a.artifact_id)}
                                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs w-full transition-colors text-slate-400 hover:bg-slate-800/50 hover:text-slate-300"
                                >
                                  <Icon className="w-3.5 h-3.5 flex-shrink-0 text-slate-500" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate">{a.name}</p>
                                    <p className="text-[10px] text-slate-600">{formatSize(a.file_size)} · {a.status}</p>
                                  </div>
                                  <ChevronDown className={`w-3 h-3 text-slate-600 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                </button>
                                {isExpanded && (
                                  <div className="px-3 py-2 ml-5 text-[11px] text-slate-400 bg-slate-900/50 rounded-lg mb-1">
                                    {a.summary ? (
                                      <div>
                                        <p className="text-[10px] text-slate-500 uppercase mb-1">Summary</p>
                                        <p className="line-clamp-4 leading-relaxed">{a.summary}</p>
                                      </div>
                                    ) : a.transcript ? (
                                      <div>
                                        <p className="text-[10px] text-slate-500 uppercase mb-1">Content</p>
                                        <p className="line-clamp-4 leading-relaxed">{a.transcript}</p>
                                      </div>
                                    ) : (
                                      <p className="text-slate-600 italic">No content available</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Sessions section */}
              {paired && (
                <div className="px-3 pt-1 pb-3 flex-1">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 px-3 mb-2">Recent Sessions</p>
                  {loadingSessions ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading...
                    </div>
                  ) : sessions.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-500">No sessions yet</p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {sessions.slice(0, 20).map(s => {
                        const isActive = s.session_id === activeSessionId;
                        return (
                          <button
                            key={s.session_id}
                            onClick={() => { onSessionSelect(s); onClose(); }}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                              isActive
                                ? 'bg-slate-800 text-white'
                                : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-300'
                            }`}
                          >
                            <MessageSquare className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-cyan-400' : 'text-slate-600'}`} />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs truncate">
                                {s.preview || s.session_id.slice(0, 8)}
                              </p>
                              <p className="text-[10px] text-slate-600 flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5" />
                                {formatSessionTime(s.last_message_at || s.created_at)}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            {paired && (
              <div className="px-3 py-4 border-t border-slate-800">
                <button
                  onClick={() => { onDisconnect(); onClose(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-red-400 hover:bg-red-900/20 w-full transition-colors"
                >
                  <Unplug className="w-5 h-5" />
                  Disconnect
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function getArtifactIcon(mime: string) {
  if (mime.startsWith('audio/')) return FileAudio;
  if (mime.startsWith('image/')) return FileImage;
  return FileText;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSessionTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}
