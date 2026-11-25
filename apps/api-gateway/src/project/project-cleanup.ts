/**
 * What goes with a project when it is deleted (DELETE /projects/:id).
 *
 * The memory service removes the project node, its links and its project-scoped skills.
 * This removes what the gateway and the agent runner keep per project:
 *   - its roles,
 *   - its missions (unscheduled, so none runs against a project that is gone),
 *   - its workflows, with their triggers (cron schedules included) and runs,
 *   - external-agent sessions in its folder, with their worktrees.
 * Agent profiles stay: they are shared, not owned by one project.
 *
 * Each part is best-effort: a failure is reported in `errors` and the rest still runs, so
 * one unavailable service never leaves the whole cleanup undone.
 */

import axios from 'axios';

export interface ProjectCleanupDeps {
  roles?: { deleteByProject(projectId: string): Promise<number> } | null;
  missions?: { list(projectId?: string): Promise<Array<{ mission_id: string; project_id?: string }>>; remove(id: string): Promise<void> } | null;
  workflows?: { listWorkflows(projectId?: string): Promise<Array<{ workflow_id: string; project_id?: string }>>; deleteWorkflow(id: string): Promise<void> } | null;
  agentSessions?: { list(): Promise<Array<{ session_id: string; project_path?: string }>>; remove(id: string): Promise<void> } | null;
}

export interface ProjectCleanupSummary {
  roles: number;
  missions: number;
  workflows: number;
  agent_sessions: number;
  errors: string[];
}

function samePath(a?: string, b?: string): boolean {
  const norm = (p?: string) => (p || '').trim().replace(/\/+$/, '');
  return !!norm(a) && norm(a) === norm(b);
}

export async function cleanupProject(
  projectId: string,
  projectPath: string | undefined,
  deps: ProjectCleanupDeps,
): Promise<ProjectCleanupSummary> {
  const summary: ProjectCleanupSummary = { roles: 0, missions: 0, workflows: 0, agent_sessions: 0, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err: any) {
      summary.errors.push(`${name}: ${err?.message || String(err)}`);
    }
  };

  await step('roles', async () => {
    if (deps.roles) summary.roles = await deps.roles.deleteByProject(projectId);
  });
  await step('missions', async () => {
    if (!deps.missions) return;
    for (const m of (await deps.missions.list(projectId)).filter(x => x.project_id === projectId)) {
      await deps.missions.remove(m.mission_id);
      summary.missions += 1;
    }
  });
  await step('workflows', async () => {
    if (!deps.workflows) return;
    for (const w of (await deps.workflows.listWorkflows(projectId)).filter(x => x.project_id === projectId)) {
      await deps.workflows.deleteWorkflow(w.workflow_id);
      summary.workflows += 1;
    }
  });
  await step('agent_sessions', async () => {
    if (!deps.agentSessions || !projectPath) return;
    for (const s of (await deps.agentSessions.list()).filter(x => samePath(x.project_path, projectPath))) {
      await deps.agentSessions.remove(s.session_id);
      summary.agent_sessions += 1;
    }
  });
  return summary;
}

/** External-agent sessions, through the agent runner's API. */
export function httpAgentSessions(baseUrl = process.env.OASIS_AGENT_URL || 'http://oasis-agent:8020'): NonNullable<ProjectCleanupDeps['agentSessions']> {
  return {
    async list() {
      const res = await axios.get(`${baseUrl}/api/v1/agents/sessions`, { timeout: 5_000 });
      return Array.isArray(res.data) ? res.data : [];
    },
    async remove(id) {
      await axios.delete(`${baseUrl}/api/v1/agents/sessions/${encodeURIComponent(id)}`, { timeout: 15_000 });
    },
  };
}
