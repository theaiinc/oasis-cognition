/**
 * Which missions a bulk action (pause all / resume all) touches, and which of them change.
 *
 * Every mission matching the optional filter (one project, one role) is in scope. Pause
 * changes what is not already fully paused; resume changes what is paused or switched off.
 */

import type { BulkMissionFilter, Mission } from './missions.types';

export function matchesFilter(m: Mission, filter: BulkMissionFilter): boolean {
  if (filter.project_id && m.project_id !== filter.project_id) return false;
  if (filter.role_id && m.role_id !== filter.role_id) return false;
  return true;
}

/** The filter from a request body: blank or non-string values mean "any". */
export function bulkFilter(body: unknown): BulkMissionFilter {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return { project_id: text(b.project_id), role_id: text(b.role_id) };
}

/** The missions in scope, and those among them the action would change. */
export function bulkTargets(all: Mission[], filter: BulkMissionFilter, op: 'pause' | 'resume'): { inScope: Mission[]; targets: Mission[] } {
  const inScope = all.filter((m) => matchesFilter(m, filter));
  const targets = inScope.filter((m) => (op === 'pause'
    ? m.enabled || m.state !== 'paused'
    : !m.enabled || m.state === 'paused'));
  return { inScope, targets };
}
