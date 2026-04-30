/**
 * In-memory store for external-agent sessions.
 *
 * Sessions are also durable-ish: the dev-agent owns the transcript + mcp
 * config files on disk, so a gateway restart loses *live* bookkeeping
 * (statuses, cached diffs) but not the user's artefacts. For v1 we accept
 * that — matches the acceptance criteria's "no auto-resume after gateway
 * restart" non-goal.
 */

import type { ExternalAgentSession } from './external-agents.types';

const sessions = new Map<string, ExternalAgentSession>();

export function putSession(s: ExternalAgentSession): void {
  sessions.set(s.session_id, s);
}

export function getSession(id: string): ExternalAgentSession | undefined {
  return sessions.get(id);
}

export function removeSession(id: string): boolean {
  return sessions.delete(id);
}

export function listSessions(): ExternalAgentSession[] {
  return [...sessions.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

/**
 * Patch a session in-place and bump `updated_at`. Returns the patched copy
 * so callers can ignore the mutation if they prefer.
 */
export function patchSession(
  id: string,
  patch: Partial<ExternalAgentSession>,
): ExternalAgentSession | undefined {
  const cur = sessions.get(id);
  if (!cur) return undefined;
  Object.assign(cur, patch, { updated_at: new Date().toISOString() });
  return cur;
}
