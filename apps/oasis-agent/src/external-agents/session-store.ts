import type { ExternalAgentSession } from './types';

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

export function patchSession(
  id: string,
  patch: Partial<ExternalAgentSession>,
): ExternalAgentSession | undefined {
  const cur = sessions.get(id);
  if (!cur) return undefined;
  Object.assign(cur, patch, { updated_at: new Date().toISOString() });
  return cur;
}
