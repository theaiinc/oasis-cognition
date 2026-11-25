import { MissionsController } from './missions.controller';
import { bulkFilter, bulkTargets, matchesFilter } from './missions-bulk';
import type { Mission } from './missions.types';

function mission(id: string, over: Partial<Mission> = {}): Mission {
  return {
    mission_id: id, goal: id, prompt: id, schedule: '0 9 * * *', enabled: true, session_id: `s-${id}`,
    notify_session_id: null, state: 'idle', run_count: 0, created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
  } as Mission;
}

const all = [
  mission('a1', { project_id: 'proj-a', role_id: 'reviewer' }),
  mission('a2', { project_id: 'proj-a' }),
  mission('b1', { project_id: 'proj-b' }),
  mission('loose'),
];

describe('bulk mission filters', () => {
  it('matches by project and role', () => {
    expect(all.filter((m) => matchesFilter(m, { project_id: 'proj-a' })).map((m) => m.mission_id)).toEqual(['a1', 'a2']);
    expect(all.filter((m) => matchesFilter(m, { role_id: 'reviewer' })).map((m) => m.mission_id)).toEqual(['a1']);
    expect(all.filter((m) => matchesFilter(m, {}))).toHaveLength(all.length);
  });

  it('reads blank and non-string filters as "any"', () => {
    expect(bulkFilter({ project_id: '  ', role_id: 3 })).toEqual({ project_id: undefined, role_id: undefined });
    expect(bulkFilter(undefined)).toEqual({ project_id: undefined, role_id: undefined });
    expect(bulkFilter({ project_id: ' proj-a ' })).toEqual({ project_id: 'proj-a', role_id: undefined });
  });

  it('pauses what is not paused and resumes what is', () => {
    const ms = [mission('p', { enabled: false, state: 'paused' }), mission('r')];
    expect(bulkTargets(ms, {}, 'pause').targets.map((m) => m.mission_id)).toEqual(['r']);
    expect(bulkTargets(ms, {}, 'resume').targets.map((m) => m.mission_id)).toEqual(['p']);
  });
});

describe('MissionsController bulk pause / resume', () => {
  function controller(missions: Mission[]) {
    const byId = new Map(missions.map((m) => [m.mission_id, { ...m }]));
    const svc = {
      list: jest.fn(async () => [...byId.values()]),
      pause: jest.fn(async (id: string) => Object.assign(byId.get(id)!, { enabled: false, state: 'paused' })),
      resume: jest.fn(async (id: string) => Object.assign(byId.get(id)!, { enabled: true, state: 'idle' })),
    };
    return { ctl: new MissionsController(svc as any), svc, byId };
  }

  it('pauses every mission, or one project\'s', async () => {
    const { ctl, svc, byId } = controller(all);
    const res = await ctl.pauseAll({ project_id: 'proj-a' });
    expect(res.changed.map((m) => m.mission_id)).toEqual(['a1', 'a2']);
    expect(svc.pause).toHaveBeenCalledTimes(2);
    expect(byId.get('b1')!.enabled).toBe(true);
    const rest = await ctl.pauseAll({});
    expect(rest.changed.map((m) => m.mission_id)).toEqual(['b1', 'loose']);
    expect(rest.unchanged).toBe(2);
  });

  it('skips missions already in the asked state', async () => {
    const { ctl, svc } = controller([mission('p', { enabled: false, state: 'paused' }), mission('r')]);
    const paused = await ctl.pauseAll({});
    expect(paused.changed.map((m) => m.mission_id)).toEqual(['r']);
    expect(paused.unchanged).toBe(1);
    const resumed = await ctl.resumeAll({});
    expect(resumed.changed.map((m) => m.mission_id).sort()).toEqual(['p', 'r']);
    expect(svc.resume).toHaveBeenCalledTimes(2);
  });
});
