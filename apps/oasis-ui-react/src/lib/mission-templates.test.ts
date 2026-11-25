import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISSION_TEMPLATES, MISSION_TEMPLATE_CATEGORIES, isValidCron, missionCreateBody, missionRequestText,
  templateProblem, templatesByCategory,
} from './mission-templates.ts';
import { ALL_MISSIONS, NO_PROJECT, NO_ROLE, bulkBody, filterMissions, filterOptions } from './mission-filters.ts';

describe('mission templates', () => {
  it('every template is valid', () => {
    for (const t of MISSION_TEMPLATES) assert.equal(templateProblem(t), null, t.id);
  });

  it('ids are unique and every category has a template', () => {
    const ids = MISSION_TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of MISSION_TEMPLATE_CATEGORIES) assert.ok(MISSION_TEMPLATES.some((t) => t.category === c.id), c.id);
    assert.equal(templatesByCategory().length, MISSION_TEMPLATE_CATEGORIES.length);
  });

  it('covers the examples: PR digest, dependency check', () => {
    const byId = new Map(MISSION_TEMPLATES.map((t) => [t.id, t]));
    assert.equal(byId.get('daily-pr-digest')?.schedule, '0 9 * * 1-5');
    assert.equal(byId.get('weekly-dependency-check')?.schedule, '0 8 * * 1');
  });

  it('never names the product (copy comes from lib/brand.ts)', () => {
    const text = JSON.stringify(MISSION_TEMPLATES) + JSON.stringify(MISSION_TEMPLATE_CATEGORIES);
    assert.doesNotMatch(text, /oasis/i);
  });

  it('checks cron expressions', () => {
    for (const ok of ['0 9 * * 1-5', '*/30 * * * *', '0 8,13 * * 1-5', '0 */3 * * 1-5', '0 0 1 1 *', '0 0 * * 7']) {
      assert.ok(isValidCron(ok), ok);
    }
    for (const bad of ['', '* * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '0 9 * * MON']) {
      assert.ok(!isValidCron(bad), bad);
    }
  });

  it('a template becomes a chat request and a create body', () => {
    const t = MISSION_TEMPLATES.find((x) => x.id === 'daily-pr-digest')!;
    const text = missionRequestText(t);
    assert.match(text, /^Create a mission: /);
    assert.ok(text.includes(`cron ${t.schedule}`));
    assert.deepEqual(missionCreateBody(t, { projectId: 'p1', sessionId: 's1' }), {
      goal: t.goal, schedule: t.schedule, project_id: 'p1', notify_session_id: 's1',
    });
    assert.deepEqual(missionCreateBody(t, {}), { goal: t.goal, schedule: t.schedule });
  });
});

describe('mission filters', () => {
  const ms = [
    { id: 'a', project_id: 'p1', role_id: 'reviewer' },
    { id: 'b', project_id: 'p2' },
    { id: 'c' },
  ];
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

  it('filters by project and role', () => {
    assert.deepEqual(ids(filterMissions(ms, ALL_MISSIONS)), ['a', 'b', 'c']);
    assert.deepEqual(ids(filterMissions(ms, { project: 'p1', role: '' })), ['a']);
    assert.deepEqual(ids(filterMissions(ms, { project: NO_PROJECT, role: '' })), ['c']);
    assert.deepEqual(ids(filterMissions(ms, { project: '', role: 'reviewer' })), ['a']);
    assert.deepEqual(ids(filterMissions(ms, { project: '', role: NO_ROLE })), ['b', 'c']);
  });

  it('lists the options and the bulk body', () => {
    assert.deepEqual(filterOptions(ms), { projects: ['p1', 'p2'], roles: ['reviewer'], hasUnprojected: true, hasRoleless: true });
    assert.deepEqual(bulkBody(ALL_MISSIONS), {});
    assert.deepEqual(bulkBody({ project: 'p1', role: 'reviewer' }), { project_id: 'p1', role_id: 'reviewer' });
    assert.equal(bulkBody({ project: NO_PROJECT, role: '' }), null);
  });
});
