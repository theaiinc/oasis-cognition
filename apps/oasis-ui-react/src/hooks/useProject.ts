/**
 * useProject — shared hook for active project state across the codebase.
 *
 * Persists the active project ID to localStorage and provides project detail
 * fetching, project list management, and convenience helpers.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type Project,
  getProject,
  listProjects,
  createProject,
  updateProject as apiUpdateProject,
  deleteProject as apiDeleteProject,
  linkArtifactToProject,
  unlinkArtifactFromProject,
  linkChatToProject,
  unlinkChatFromProject,
  activateProject,
} from '@/lib/artifact-api';

const STORAGE_KEY = 'oasis_active_project';

export function useProject() {
  const [activeProjectId, setActiveProjectIdRaw] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);

  // ── Persist active project ──────────────────────────────────────────

  const setActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectIdRaw(id);
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    // Notify the backend so PROJECT_ROOT and settings are applied
    activateProject(id).catch(() => { /* dev-agent may be down */ });
  }, []);

  // ── Fetch project detail ────────────────────────────────────────────

  const refreshActiveProject = useCallback(async () => {
    if (!activeProjectId) {
      setActiveProject(null);
      return null;
    }
    try {
      const detail = await getProject(activeProjectId);
      setActiveProject(detail);
      return detail;
    } catch {
      setActiveProject(null);
      return null;
    }
  }, [activeProjectId]);

  // ── Fetch project list ──────────────────────────────────────────────

  const refreshProjects = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProjects();
      setProjects(list);
      return list;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-fetch active project detail when ID changes
  useEffect(() => {
    refreshActiveProject();
  }, [refreshActiveProject]);

  // On mount, sync the persisted active project ID to the backend
  useEffect(() => {
    if (activeProjectId) {
      activateProject(activeProjectId).catch(() => { /* ignore */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── CRUD helpers ────────────────────────────────────────────────────

  const create = useCallback(async (name: string, description?: string) => {
    const project = await createProject(name, description);
    await refreshProjects();
    return project;
  }, [refreshProjects]);

  const update = useCallback(async (id: string, data: { name?: string; description?: string; project_path?: string }) => {
    await apiUpdateProject(id, data);
    await refreshProjects();
    if (id === activeProjectId) await refreshActiveProject();
  }, [activeProjectId, refreshProjects, refreshActiveProject]);

  const remove = useCallback(async (id: string) => {
    await apiDeleteProject(id);
    if (id === activeProjectId) setActiveProjectId(null);
    await refreshProjects();
  }, [activeProjectId, setActiveProjectId, refreshProjects]);

  // ── Linking helpers ─────────────────────────────────────────────────

  const linkArtifact = useCallback(async (artifactId: string) => {
    if (!activeProjectId) return;
    await linkArtifactToProject(activeProjectId, artifactId);
    await refreshActiveProject();
  }, [activeProjectId, refreshActiveProject]);

  const unlinkArtifact = useCallback(async (artifactId: string) => {
    if (!activeProjectId) return;
    await unlinkArtifactFromProject(activeProjectId, artifactId);
    await refreshActiveProject();
  }, [activeProjectId, refreshActiveProject]);

  const toggleArtifactLink = useCallback(async (artifactId: string) => {
    if (!activeProjectId || !activeProject) return;
    const isLinked = activeProject.artifacts?.some(a => a.artifact_id === artifactId);
    if (isLinked) {
      await unlinkArtifact(artifactId);
    } else {
      await linkArtifact(artifactId);
    }
  }, [activeProjectId, activeProject, linkArtifact, unlinkArtifact]);

  const isArtifactLinked = useCallback((artifactId: string): boolean => {
    return activeProject?.artifacts?.some(a => a.artifact_id === artifactId) ?? false;
  }, [activeProject]);

  const linkChat = useCallback(async (sessionId: string) => {
    if (!activeProjectId) return;
    await linkChatToProject(activeProjectId, sessionId);
    await refreshActiveProject();
  }, [activeProjectId, refreshActiveProject]);

  const unlinkChat = useCallback(async (sessionId: string) => {
    if (!activeProjectId) return;
    await unlinkChatFromProject(activeProjectId, sessionId);
    await refreshActiveProject();
  }, [activeProjectId, refreshActiveProject]);

  return {
    // State
    activeProjectId,
    activeProject,
    projects,
    loading,

    // Setters
    setActiveProjectId,

    // Refresh
    refreshActiveProject,
    refreshProjects,

    // CRUD
    createProject: create,
    updateProject: update,
    deleteProject: remove,

    // Linking
    linkArtifact,
    unlinkArtifact,
    toggleArtifactLink,
    isArtifactLinked,
    linkChat,
    unlinkChat,
  };
}
