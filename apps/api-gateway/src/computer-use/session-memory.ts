/**
 * SessionMemory — durable per-session storage for CU agent.
 *
 * Stores session state + step outputs on disk at ~/.oasis/cu-sessions/<session_id>/
 * via the dev-agent's cu-file endpoints. Survives gateway restarts.
 *
 * OpenClaw-inspired file layout:
 *   SESSION.json       — full serialized session state (plan, status, current_step)
 *   MEMORY.md          — curated facts (typed content, URLs, decisions, discoveries)
 *   SCRATCH.md         — working draft (multi-step reasoning the agent reuses)
 *   USER_NOTES.md      — user-injected instructions during execution
 *   memory/NNN-action.md — per-step FULL output (no truncation)
 *   screenshots/NNN-{before,after}.jpg — visual evidence per step
 */

import axios from 'axios';
import type { ComputerUseSession, PlanStep } from './computer-use.types';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://host.docker.internal:8008';

export class SessionMemory {
  constructor(private readonly sessionId: string) {}

  /** Write a file in the session dir. */
  async write(path: string, content: string, append = false): Promise<boolean> {
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/cu-file/write`, {
        session_id: this.sessionId, path, content, append,
      }, { timeout: 5000 });
      return !!res.data?.success;
    } catch {
      return false;
    }
  }

  /** Read a file from the session dir. Returns empty string if missing. */
  async read(path: string, offset = 0, limit = 0): Promise<string> {
    try {
      const res = await axios.post(`${DEV_AGENT_URL}/internal/dev-agent/cu-file/read`, {
        session_id: this.sessionId, path, offset, limit,
      }, { timeout: 5000 });
      if (res.data?.success) return (res.data.content || '') as string;
      return '';
    } catch {
      return '';
    }
  }

  /** List files in a subdirectory (or the session root if subdir omitted). */
  async list(subdir = ''): Promise<Array<{ name: string; is_dir: boolean; size: number }>> {
    try {
      const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/cu-file/list`, {
        params: { session_id: this.sessionId, subdir },
        timeout: 5000,
      });
      return (res.data?.files || []);
    } catch {
      return [];
    }
  }

  /** Snapshot the session to SESSION.json (fire-and-forget). */
  async snapshot(session: ComputerUseSession): Promise<void> {
    const snap = {
      ...session,
      // Strip internal fields that shouldn't survive (they can be huge and
      // some, like click_assist screenshots, are transient).
      _screen_image: undefined,
      _click_assist: undefined,
      // Don't serialize live_screenshot — can be several MB base64
      live_screenshot: undefined,
    };
    await this.write('SESSION.json', JSON.stringify(snap, null, 2));
  }

  /** Write a per-step full output file (no truncation). */
  async writeStep(step: PlanStep, extra: { thought?: string; before?: string; after?: string } = {}): Promise<void> {
    const idx = String(step.index + 1).padStart(3, '0');
    const safeAction = (step.action || 'step').replace(/[^a-z0-9_-]/gi, '_');
    const parts: string[] = [
      `# Step ${step.index + 1}: ${step.action}`,
      '',
      `**Status:** ${step.status}`,
      `**Target:** ${step.target || '(none)'}`,
      `**Description:** ${step.description || ''}`,
      ...(step.started_at ? [`**Started:** ${step.started_at}`] : []),
      ...(step.completed_at ? [`**Completed:** ${step.completed_at}`] : []),
    ];
    if (extra.thought) {
      parts.push('', '## THOUGHT', extra.thought);
    }
    if (step.output) {
      parts.push('', '## OUTPUT', step.output);
    }
    if (extra.before) {
      parts.push('', '## PAGE BEFORE', extra.before);
    }
    if (extra.after) {
      parts.push('', '## PAGE AFTER', extra.after);
    }
    await this.write(`memory/${idx}-${safeAction}.md`, parts.join('\n'));
  }

  /** Append a key fact to MEMORY.md. */
  async addFact(fact: string): Promise<void> {
    const line = `- [${new Date().toISOString()}] ${fact.replace(/\n/g, ' ').slice(0, 500)}\n`;
    await this.write('MEMORY.md', line, true);
  }

  /** Load the full MEMORY.md. */
  async loadMemory(): Promise<string> {
    return this.read('MEMORY.md');
  }

  /** Load a scratchpad file (SCRATCH.md by default). */
  async loadScratch(): Promise<string> {
    return this.read('SCRATCH.md');
  }

  /** Write/overwrite the scratchpad. */
  async writeScratch(content: string): Promise<void> {
    await this.write('SCRATCH.md', content);
  }

  /** Load recent step files (for context in the REACT prompt). */
  async loadRecentSteps(n = 3): Promise<string> {
    const files = await this.list('memory');
    const mdFiles = files
      .filter(f => !f.is_dir && f.name.endsWith('.md'))
      .map(f => f.name)
      .sort()
      .slice(-n);
    const out: string[] = [];
    for (const name of mdFiles) {
      const content = await this.read(`memory/${name}`);
      if (content) out.push(content);
    }
    return out.join('\n\n---\n\n');
  }
}

/** List all session IDs stored on disk. Used by gateway startup to rehydrate. */
export async function listStoredSessions(): Promise<string[]> {
  try {
    const res = await axios.get(`${DEV_AGENT_URL}/internal/dev-agent/cu-file/list-sessions`, {
      timeout: 5000,
    });
    return (res.data?.sessions || []).map((s: { session_id: string }) => s.session_id);
  } catch {
    return [];
  }
}

/** Load a session from disk by session_id. */
export async function loadSessionFromDisk(sessionId: string): Promise<ComputerUseSession | null> {
  const mem = new SessionMemory(sessionId);
  const content = await mem.read('SESSION.json');
  if (!content) return null;
  try {
    return JSON.parse(content) as ComputerUseSession;
  } catch {
    return null;
  }
}

/**
 * Promote a completed session's MEMORY.md to the artifact service for
 * cross-session semantic retrieval. Returns the artifact_id if successful.
 *
 * Uses the existing artifact service's /artifacts/upload endpoint which
 * handles embedding + Neo4j storage automatically.
 */
export async function promoteSessionToArtifacts(
  sessionId: string,
  goal: string,
  projectId?: string,
): Promise<string | null> {
  try {
    const mem = new SessionMemory(sessionId);
    const memoryMd = await mem.loadMemory();
    if (!memoryMd || memoryMd.length < 20) return null;

    // Build a single markdown file summarizing the session's learnings
    const scratch = await mem.loadScratch();
    const body = [
      `# CU Session Memory: ${sessionId}`,
      '',
      `**Goal:** ${goal}`,
      `**Session ID:** ${sessionId}`,
      `**Captured:** ${new Date().toISOString()}`,
      '',
      '## Facts learned',
      '',
      memoryMd,
      ...(scratch ? ['', '## Working draft', '', scratch] : []),
    ].join('\n');

    const ARTIFACT_URL = process.env.ARTIFACT_URL || 'http://artifact-service:8002';
    const filename = `cu-session-${sessionId}.md`;

    // The artifact service accepts multipart uploads. Send as text file.
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', Buffer.from(body, 'utf-8'), { filename, contentType: 'text/markdown' });
    if (projectId) form.append('project_id', projectId);
    form.append('source_type', 'cu_session');
    form.append('name', `CU Session: ${goal.slice(0, 60)}`);

    const res = await axios.post(`${ARTIFACT_URL}/internal/artifacts/upload`, form, {
      headers: form.getHeaders(),
      timeout: 15000,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
    });
    return res.data?.artifact_id || null;
  } catch {
    return null;
  }
}
