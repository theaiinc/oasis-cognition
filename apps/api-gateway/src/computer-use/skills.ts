/**
 * CU skill registry — DB-backed via the memory service.
 *
 * The skill registry lives in Neo4j (managed by services/memory_service). Each
 * skill carries a regex `match_pattern` and two text blobs:
 *
 *   - `plan_guidance` — injected into the PLAN system prompt during goal
 *     decomposition so draftPlan produces better steps.
 *   - `react_guidance` — injected into each REACT userMessage so step execution
 *     benefits from app-specific context (modal flows, button labels, stale-DOM
 *     pitfalls).
 *
 * This module is a thin async client: it caches the skill list with a short
 * TTL, regex-matches locally, and degrades to bundled fallback data if the
 * memory service is unreachable. Seed content is maintained in
 * `services/memory_service/data/cu_skills_seed.json` and upserted on memory
 * service startup — edit the seed, restart memory service, and the agent picks
 * up the new guidance without redeploying the API gateway.
 *
 * Keep the guidance terse. Long prompts dilute LLM attention.
 */

import axios from 'axios';

const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

export interface CUSkill {
  id: string;
  name: string;
  /** Regex pattern (no flags; `i` is always applied). Tested with RegExp.test(goal). */
  matchPattern: string;
  /** Text injected into the PLAN system prompt during goal decomposition. */
  planGuidance: string;
  /** Text injected into the REACT userMessage during each sub-step decision. */
  reactGuidance: string;
  source: 'handcrafted' | 'learned';
  enabled: boolean;
}

/**
 * Bundled fallback: a minimal subset of the seed, used only if the memory
 * service is unreachable during a CU session. Keep this short — the source of
 * truth is `services/memory_service/data/cu_skills_seed.json`. This is just a
 * safety net so CU doesn't lose ALL skill guidance when Neo4j is down.
 */
const FALLBACK_SKILLS: CUSkill[] = [
  {
    id: 'facebook-compose-post',
    name: 'Facebook: Compose and Publish Post',
    matchPattern:
      '^(?=.*(?:facebook|\\bfb\\b))(?=.*\\b(?:post|share|publish|wall|timeline|status)\\b)(?!.*(?:\\b(?:edit|update|modify|change)\\b|chỉnh|sửa|cập nhật))',
    planGuidance:
      'KNOWN SKILL: Facebook Compose. Click "What\'s on your mind" → MODAL → type → click "Post" ONCE. Use Chrome Bridge "click", never "click_screen". NEVER click Close / Cancel / Discard / X.',
    reactGuidance:
      'FACEBOOK compose: Chrome Bridge click only. Composer is a MODAL. "Post" once then stop.',
    source: 'handcrafted',
    enabled: true,
  },
  {
    id: 'facebook-edit-post',
    name: 'Facebook: Edit Existing Post',
    matchPattern:
      '^(?=.*(?:facebook|\\bfb\\b))(?=.*(?:\\b(?:edit|update|modify|change)\\b|chỉnh|sửa|cập nhật))(?=.*(?:\\b(?:post|status|wall|timeline)\\b|bài))',
    planGuidance:
      'KNOWN SKILL: Facebook Edit Post. Start at facebook.com/me (home feed hides own posts). Scroll + read_screen until target-post PREFIX (30–80 chars) appears. Click "..." / "Actions for this post" / "Tùy chọn khác cho bài viết này" on that post → "Edit post" / "Chỉnh sửa bài viết" → click text area → cmd+a → type new content → "Save" / "Lưu". Never click Delete / Xóa / Hide / Cancel / Hủy.',
    reactGuidance:
      'FACEBOOK edit: start at facebook.com/me, scroll to find post by PREFIX, click "..." on target post → Edit post → cmd+a → type → Save. Never Delete/Xóa/Hide/Cancel.',
    source: 'handcrafted',
    enabled: true,
  },
];

type SkillRow = {
  id?: string;
  name?: string;
  match_pattern?: string;
  plan_guidance?: string;
  react_guidance?: string;
  source?: string;
  enabled?: boolean;
};

let _cache: { skills: CUSkill[]; fetchedAt: number } | null = null;
let _inflight: Promise<CUSkill[]> | null = null;

function rowToSkill(row: SkillRow): CUSkill | null {
  if (!row || !row.id || !row.name) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    matchPattern: String(row.match_pattern || ''),
    planGuidance: String(row.plan_guidance || ''),
    reactGuidance: String(row.react_guidance || ''),
    source: (row.source === 'learned' ? 'learned' : 'handcrafted'),
    enabled: row.enabled !== false,
  };
}

async function fetchSkillsFromMemory(): Promise<CUSkill[]> {
  const res = await axios.get(`${MEMORY_URL}/internal/memory/cu/skill/guidance`, {
    timeout: FETCH_TIMEOUT_MS,
  });
  const rows: SkillRow[] = Array.isArray(res.data?.skills) ? res.data.skills : [];
  const skills = rows.map(rowToSkill).filter((s): s is CUSkill => !!s && s.enabled);
  return skills;
}

/**
 * Return the current set of enabled guidance skills, refreshing from the memory
 * service when the cache is stale. Falls back to bundled skills if the memory
 * service is unreachable.
 */
export async function getAllSkills(): Promise<CUSkill[]> {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.skills;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const skills = await fetchSkillsFromMemory();
      _cache = { skills, fetchedAt: now };
      return skills;
    } catch (err: any) {
      // Don't cache failures — try again next call. But keep serving whatever
      // we have (stale cache > bundled fallback > empty).
      if (_cache) return _cache.skills;
      // eslint-disable-next-line no-console
      console.warn(`[cu-skills] memory service unreachable (${err?.message || err}); using bundled fallback`);
      return FALLBACK_SKILLS;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Force a refresh on the next call (e.g. after upserting a new skill). */
export function invalidateSkillCache(): void {
  _cache = null;
}

function skillMatches(skill: CUSkill, goal: string): boolean {
  if (!skill.enabled || !skill.matchPattern) return false;
  try {
    const re = new RegExp(skill.matchPattern, 'i');
    return re.test(goal);
  } catch {
    return false;
  }
}

/** Return all skills whose match_pattern matches the given goal. */
export async function matchSkills(goal: string): Promise<CUSkill[]> {
  const all = await getAllSkills();
  return all.filter(s => skillMatches(s, goal));
}

/** Build the planGuidance block from all matched skills (empty string if none). */
export async function planGuidanceFor(goal: string): Promise<string> {
  const matched = await matchSkills(goal);
  if (matched.length === 0) return '';
  return matched.map(s => s.planGuidance).filter(Boolean).join('\n\n') + '\n\n';
}

/** Build the reactGuidance block from all matched skills (empty string if none). */
export async function reactGuidanceFor(goal: string): Promise<string> {
  const matched = await matchSkills(goal);
  if (matched.length === 0) return '';
  const parts = matched.map(s => s.reactGuidance).filter(Boolean);
  if (parts.length === 0) return '';
  return '\n' + parts.join('\n\n') + '\n';
}
