import axios from 'axios';
import { OASIS_BASE_URL } from '@/lib/constants';

const API = `${OASIS_BASE_URL}/api/v1`;

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface Artifact {
  artifact_id: string;
  name: string;
  mime_type: string;
  file_path: string;
  file_size: number;
  source_type: 'upload' | 'youtube';
  source_url?: string;
  status: 'pending' | 'queued' | 'processing' | 'ready' | 'error';
  transcript?: string;
  summary?: string;
  language?: string;
  created_at: string;
  updated_at: string;
  projects?: string[];
}

export interface Project {
  project_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  artifact_count?: number;
  chat_count?: number;
  repo_count?: number;
  artifacts?: Artifact[];
  chats?: Array<{ session_id: string; label?: string }>;
  repos?: Array<{ repo_id: string; git_url: string; name: string }>;
}

export interface SearchResult {
  chunk_text: string;
  chunk_index: number;
  artifact_id: string;
  artifact_name: string;
  similarity: number;
}

/* ── Artifacts ──────────────────────────────────────────────────────────── */

export async function uploadArtifact(
  file: File,
  opts?: { language?: string; project_id?: string },
): Promise<Artifact> {
  const form = new FormData();
  form.append('file', file);
  if (opts?.language) form.append('language', opts.language);
  if (opts?.project_id) form.append('project_id', opts.project_id);
  const res = await axios.post(`${API}/artifacts/upload`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300000,
  });
  return res.data.artifact;
}

export async function uploadYoutube(
  url: string,
  opts?: { language?: string; project_id?: string },
): Promise<Artifact> {
  const res = await axios.post(`${API}/artifacts/youtube`, {
    url,
    ...opts,
  }, { timeout: 600000 });
  return res.data.artifact;
}

export async function listArtifacts(projectId?: string): Promise<Artifact[]> {
  const res = await axios.get(`${API}/artifacts`, {
    params: projectId ? { project_id: projectId } : {},
  });
  return res.data.artifacts;
}

export function getArtifactDownloadUrl(id: string): string {
  return `${API}/artifacts/${id}/download`;
}

export async function getArtifact(id: string): Promise<Artifact> {
  const res = await axios.get(`${API}/artifacts/${id}`);
  return res.data;
}

export async function deleteArtifact(id: string): Promise<void> {
  await axios.delete(`${API}/artifacts/${id}`);
}

export async function processArtifact(id: string): Promise<{ status: string; text_length?: number }> {
  const res = await axios.post(`${API}/artifacts/${id}/process`, {}, { timeout: 600000 });
  return res.data;
}

export async function summarizeArtifact(id: string, opts?: { language?: string; instructions?: string }): Promise<{ summary: string }> {
  const res = await axios.post(`${API}/artifacts/${id}/summarize`, opts || {}, { timeout: 120000 });
  return res.data;
}

export async function searchArtifacts(
  query: string,
  opts?: { limit?: number; project_id?: string },
): Promise<SearchResult[]> {
  const res = await axios.get(`${API}/artifacts/search`, {
    params: { q: query, limit: opts?.limit ?? 10, ...(opts?.project_id ? { project_id: opts.project_id } : {}) },
  });
  return res.data.results;
}

/* ── Projects ──────────────────────────────────────────────────────────── */

export async function createProject(name: string, description?: string): Promise<Project> {
  const res = await axios.post(`${API}/projects`, { name, description });
  return res.data.project;
}

export async function listProjects(): Promise<Project[]> {
  const res = await axios.get(`${API}/projects`);
  return res.data.projects;
}

export async function getProject(id: string): Promise<Project> {
  const res = await axios.get(`${API}/projects/${id}`);
  return res.data;
}

export async function updateProject(id: string, data: { name?: string; description?: string; project_path?: string }): Promise<void> {
  await axios.patch(`${API}/projects/${id}`, data);
}

export async function deleteProject(id: string): Promise<void> {
  await axios.delete(`${API}/projects/${id}`);
}

export async function linkArtifactToProject(projectId: string, artifactId: string): Promise<void> {
  await axios.post(`${API}/projects/${projectId}/artifacts`, { artifact_id: artifactId });
}

export async function unlinkArtifactFromProject(projectId: string, artifactId: string): Promise<void> {
  await axios.delete(`${API}/projects/${projectId}/artifacts/${artifactId}`);
}

export async function linkChatToProject(projectId: string, sessionId: string): Promise<void> {
  await axios.post(`${API}/projects/${projectId}/chats`, { session_id: sessionId });
}

export async function unlinkChatFromProject(projectId: string, sessionId: string): Promise<void> {
  await axios.delete(`${API}/projects/${projectId}/chats/${sessionId}`);
}

export async function createRepo(gitUrl: string, name?: string): Promise<{ repo_id: string }> {
  const res = await axios.post(`${API}/projects/repos`, { git_url: gitUrl, name });
  return res.data.repo;
}

export async function linkRepoToProject(projectId: string, repoId: string): Promise<void> {
  await axios.post(`${API}/projects/${projectId}/repos`, { repo_id: repoId });
}

export async function unlinkRepoFromProject(projectId: string, repoId: string): Promise<void> {
  await axios.delete(`${API}/projects/${projectId}/repos/${repoId}`);
}

export async function scopeRuleToProject(ruleId: string, projectId: string): Promise<void> {
  await axios.post(`${API}/projects/rules/scope`, { rule_id: ruleId, project_id: projectId });
}

/* ── Speakers ─────────────────────────────────────────────────────────── */

export interface SpeakerProfile {
  speaker_id: string;
  name: string;
  source_artifact_id?: string;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

export async function listSpeakers(): Promise<SpeakerProfile[]> {
  const res = await axios.get(`${API}/speakers`);
  return res.data.speakers;
}

export async function createSpeaker(name: string, embedding: number[], sourceArtifactId?: string): Promise<SpeakerProfile> {
  const res = await axios.post(`${API}/speakers`, {
    name,
    embedding,
    source_artifact_id: sourceArtifactId,
  });
  return res.data.speaker;
}

export async function enrollSpeaker(artifactId: string, name: string): Promise<SpeakerProfile> {
  const res = await axios.post(`${API}/speakers/enroll`, {
    artifact_id: artifactId,
    name,
  }, { timeout: 120000 });
  return res.data.speaker;
}

export async function updateSpeaker(id: string, data: { name?: string }): Promise<void> {
  await axios.patch(`${API}/speakers/${id}`, data);
}

export async function deleteSpeaker(id: string): Promise<void> {
  await axios.delete(`${API}/speakers/${id}`);
}

/* ── Project Settings (per-project config) ────────────────────────────── */

export async function activateProject(projectId: string | null): Promise<{ project_id: string | null; project_root: string }> {
  const res = await axios.post(`${API}/project/activate`, { project_id: projectId }, { timeout: 15000 });
  return res.data;
}

export async function getActiveProject(): Promise<{ project_id: string | null; settings: Record<string, any>; project_root: string }> {
  const res = await axios.get(`${API}/project/active`, { timeout: 10000 });
  return res.data;
}

export async function getProjectSettings(projectId: string): Promise<{ settings: Record<string, any> }> {
  const res = await axios.get(`${API}/project/settings/${projectId}`, { timeout: 10000 });
  return res.data;
}

export async function saveProjectSettings(projectId: string, settings: Record<string, any>): Promise<void> {
  await axios.post(`${API}/project/settings`, { project_id: projectId, settings }, { timeout: 15000 });
}

/* ── SSE: Real-time artifact events ────────────────────────────────────── */

export interface ArtifactSSEEvent {
  event: 'snapshot' | 'status' | 'error';
  artifact_id?: string;
  status?: string;
  position?: number;
  current_processing?: string | null;
  queue?: string[];
  message?: string;
}

/**
 * Subscribe to real-time artifact processing events via SSE.
 * Returns a cleanup function to close the connection.
 */
export function subscribeToArtifactEvents(
  onEvent: (evt: ArtifactSSEEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource(`${API}/artifacts/events`);

  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as ArtifactSSEEvent;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = (err) => {
    onError?.(err);
  };

  return () => es.close();
}
