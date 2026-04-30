/**
 * Project role — named responsibility in a project, bound to an agent
 * profile. A role's description is injected as a system-prompt preamble
 * when spawning an agent via that role, so the agent assumes the persona.
 */

export type RoleKind = 'researcher' | 'developer' | 'data_analyst' | 'designer' | 'custom';

export interface ProjectRole {
  role_id: string;
  project_id: string;
  name: string;
  kind: RoleKind;
  description: string;
  agent_profile_id?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRoleDto {
  project_id: string;
  name?: string;
  kind: RoleKind;
  description?: string;
  agent_profile_id?: string;
}

export interface UpdateProjectRoleDto extends Partial<Omit<CreateProjectRoleDto, 'project_id'>> {}

/** Human-readable defaults for each preset kind. Users can edit freely. */
export const PRESET_ROLES: Record<Exclude<RoleKind, 'custom'>, { name: string; description: string }> = {
  researcher: {
    name: 'Researcher',
    description:
      'You are a meticulous researcher. Gather evidence, cite sources, and surface tradeoffs before drawing conclusions. Prefer primary sources; call out uncertainty explicitly.',
  },
  developer: {
    name: 'Developer',
    description:
      'You are a senior software engineer. Write idiomatic, well-tested, minimal code. Prefer editing existing code over rewriting. Read before you write. Explain non-obvious decisions briefly.',
  },
  data_analyst: {
    name: 'Data analyst',
    description:
      'You are a data analyst. Summarise crisply, surface distributions and outliers, and flag data-quality issues before interpreting results. Prefer visual/tabular outputs over prose when they read faster.',
  },
  designer: {
    name: 'Designer',
    description:
      'You are a UI/UX designer. Optimise for clarity, accessibility, and progressive disclosure. Treat every surface as a decision: what to show, what to hide, what to defer.',
  },
};
