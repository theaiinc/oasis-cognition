/** Filters for the active-missions bar: by project and by role. */

export interface FilterableMission {
  project_id?: string;
  role_id?: string;
}

export interface MissionFilter {
  /** '' = every project; NO_PROJECT = missions not in a project. */
  project: string;
  /** '' = every role; NO_ROLE = missions with no role. */
  role: string;
}

export const NO_PROJECT = '__none__';
export const NO_ROLE = '__none__';
export const ALL_MISSIONS: MissionFilter = { project: '', role: '' };

export function filterMissions<T extends FilterableMission>(missions: T[], f: MissionFilter): T[] {
  return missions.filter((m) => {
    if (f.project === NO_PROJECT ? !!m.project_id : f.project && m.project_id !== f.project) return false;
    if (f.role === NO_ROLE ? !!m.role_id : f.role && m.role_id !== f.role) return false;
    return true;
  });
}

/** The distinct projects and roles among `missions`, for the filter menus (sorted, each once). */
export function filterOptions(missions: FilterableMission[]) {
  const projects = [...new Set(missions.map((m) => m.project_id).filter((p): p is string => !!p))].sort();
  const roles = [...new Set(missions.map((m) => m.role_id).filter((r): r is string => !!r))].sort();
  return {
    projects,
    roles,
    hasUnprojected: missions.some((m) => !m.project_id),
    hasRoleless: missions.some((m) => !m.role_id),
  };
}

/**
 * The body for POST /api/v1/missions/pause-all or resume-all that matches the filter,
 * or null when the gateway can't express it (the "no project" / "no role" choices):
 * then the bar acts on each shown mission one by one.
 */
export function bulkBody(f: MissionFilter): { project_id?: string; role_id?: string } | null {
  if (f.project === NO_PROJECT || f.role === NO_ROLE) return null;
  return { ...(f.project ? { project_id: f.project } : {}), ...(f.role ? { role_id: f.role } : {}) };
}
