/**
 * Mission templates: ready-made recurring goals for the template gallery in an empty
 * chat. Add one by appending to MISSION_TEMPLATES (and a category to
 * MISSION_TEMPLATE_CATEGORIES if it needs a new group); mission-templates.test.ts
 * checks every entry.
 *
 * Copy here never names the product: it is sent to the agent or shown under the
 * brand set in lib/brand.ts.
 */

export type MissionTemplateCategory = 'code' | 'dependencies' | 'planning';

export interface MissionTemplate {
  id: string;
  category: MissionTemplateCategory;
  /** Short title for the gallery card. */
  title: string;
  /** One line under the title. */
  summary: string;
  /** The mission's goal: what it does on every run. */
  goal: string;
  /** Standard 5-field cron expression. */
  schedule: string;
  /** Plain-words schedule shown next to the cron. */
  scheduleLabel: string;
}

export const MISSION_TEMPLATE_CATEGORIES: Array<{ id: MissionTemplateCategory; label: string }> = [
  { id: 'code', label: 'Code & reviews' },
  { id: 'dependencies', label: 'Dependencies & health' },
  { id: 'planning', label: 'Planning' },
];

export const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    id: 'daily-pr-digest',
    category: 'code',
    title: 'Daily PR digest',
    summary: "Open pull requests in this project's repository, newest activity first.",
    goal: "Summarise the open pull requests in this project's repository: what each changes, who is waiting on whom, and anything with no activity for 2+ days.",
    schedule: '0 9 * * 1-5',
    scheduleLabel: 'Weekdays at 09:00',
  },
  {
    id: 'yesterday-commits',
    category: 'code',
    title: 'What shipped yesterday',
    summary: 'Commits of the last 24 hours, grouped by feature area.',
    goal: 'Summarise what was committed in the last 24 hours, grouped by feature area rather than by commit, and point out anything that looks risky.',
    schedule: '0 9 * * 1-5',
    scheduleLabel: 'Weekdays at 09:00',
  },
  {
    id: 'stale-reviews',
    category: 'code',
    title: 'Reviews waiting on me',
    summary: 'Pull requests asking for my review, flagged after 24 hours.',
    goal: 'List the pull requests waiting on my review and flag any that have waited more than 24 hours.',
    schedule: '0 */3 * * 1-5',
    scheduleLabel: 'Every 3 hours on weekdays',
  },
  {
    id: 'weekly-dependency-check',
    category: 'dependencies',
    title: 'Weekly dependency check',
    summary: 'Outdated and vulnerable packages, with the upgrades worth doing.',
    goal: "Check this project's dependencies for outdated packages and known vulnerabilities (npm outdated / npm audit, pip list --outdated or the project's equivalent) and recommend which upgrades to do first. Do not change any files.",
    schedule: '0 8 * * 1',
    scheduleLabel: 'Mondays at 08:00',
  },
  {
    id: 'new-todos',
    category: 'dependencies',
    title: 'New TODOs',
    summary: 'TODO and FIXME comments added since the previous run.',
    goal: 'Scan the codebase for TODO and FIXME comments added since the previous run and report what changed, by file.',
    schedule: '0 17 * * 1-5',
    scheduleLabel: 'Weekdays at 17:00',
  },
  {
    id: 'weekly-plan',
    category: 'planning',
    title: 'Weekly plan',
    summary: "Last week's progress and a short plan for this week.",
    goal: "Write a short weekly plan for this project: what got done last week (from commits and closed pull requests), what is still open, and the three most useful things to do this week.",
    schedule: '0 9 * * 1',
    scheduleLabel: 'Mondays at 09:00',
  },
];

const CRON_FIELDS: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 are Sunday)
];

/** Whether `expr` is a plain 5-field cron (numbers, *, ranges, lists, steps): what the gateway accepts and the templates use. */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((field, i) => field.split(',').every((piece) => {
    const { min, max } = CRON_FIELDS[i];
    const m = piece.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return false;
    const [, , lo, hi, step] = m;
    if (step !== undefined && Number(step) < 1) return false;
    if (lo === undefined) return true; // "*" or "*/n"
    const a = Number(lo);
    const b = hi === undefined ? a : Number(hi);
    return a >= min && b <= max && a <= b;
  }));
}

/** What is wrong with a template, or null. */
export function templateProblem(t: MissionTemplate): string | null {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id)) return `id "${t.id}" must be kebab-case`;
  if (!MISSION_TEMPLATE_CATEGORIES.some((c) => c.id === t.category)) return `${t.id}: unknown category ${t.category}`;
  if (!t.title.trim() || t.title.length > 40) return `${t.id}: title must be 1-40 characters`;
  if (!t.summary.trim() || t.summary.length > 100) return `${t.id}: summary must be 1-100 characters`;
  if (t.goal.trim().length < 20 || t.goal.length > 600) return `${t.id}: goal must be 20-600 characters`;
  if (!isValidCron(t.schedule)) return `${t.id}: invalid cron "${t.schedule}"`;
  if (!t.scheduleLabel.trim()) return `${t.id}: scheduleLabel is required`;
  return null;
}

/** Templates by category, in category order; empty categories left out. */
export function templatesByCategory(templates: MissionTemplate[] = MISSION_TEMPLATES) {
  return MISSION_TEMPLATE_CATEGORIES
    .map((c) => ({ ...c, templates: templates.filter((t) => t.category === c.id) }))
    .filter((c) => c.templates.length > 0);
}

/** A chat message asking the agent to create the mission (mission_create), ready to send. */
export function missionRequestText(t: MissionTemplate): string {
  return `Create a mission: ${t.goal} Schedule: ${t.scheduleLabel.toLowerCase()} (cron ${t.schedule}).`;
}

/** The body for POST /api/v1/missions that creates the mission directly. */
export function missionCreateBody(t: MissionTemplate, opts: { projectId?: string | null; sessionId?: string | null }) {
  return {
    goal: t.goal,
    schedule: t.schedule,
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    ...(opts.sessionId ? { notify_session_id: opts.sessionId } : {}),
  };
}
