/**
 * Run retention (#21): runs expire after OASIS_WORKFLOW_RUN_TTL_DAYS, each workflow keeps
 * its newest OASIS_WORKFLOW_MAX_RUNS, and pruning deletes the run doc and stream, not only
 * the index entry. The in-memory fallback is always tested; the Redis path runs when
 * REDIS_TEST_URL points at a disposable Redis (it flushes that database).
 */
import Redis from 'ioredis';
import { WorkflowStore, maxRunsPerWorkflow, runTtlSeconds } from './redis-store';
import type { WorkflowRun } from '../workflows.types';

const DAY = 86_400_000;
const ENV = ['OASIS_WORKFLOW_RUN_TTL_DAYS', 'OASIS_WORKFLOW_MAX_RUNS', 'REDIS_URL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function run(id: string, ageMs: number, workflowId = 'wf1'): WorkflowRun {
  return {
    run_id: id,
    workflow_id: workflowId,
    status: 'completed',
    context: {},
    node_states: {},
    created_at: new Date(Date.now() - ageMs).toISOString(),
  } as WorkflowRun;
}

async function waitReady(store: WorkflowStore, ready: boolean) {
  for (let i = 0; i < 50; i++) {
    if (!!store.getRaw() === ready) return;
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('retention settings', () => {
  it('defaults to 30 days and 200 runs, and 0 days turns expiry off', () => {
    delete process.env.OASIS_WORKFLOW_RUN_TTL_DAYS;
    delete process.env.OASIS_WORKFLOW_MAX_RUNS;
    expect(runTtlSeconds()).toBe(30 * 86_400);
    expect(maxRunsPerWorkflow()).toBe(200);
    process.env.OASIS_WORKFLOW_RUN_TTL_DAYS = '0';
    process.env.OASIS_WORKFLOW_MAX_RUNS = 'junk';
    expect(runTtlSeconds()).toBe(0);
    expect(maxRunsPerWorkflow()).toBe(200);
  });
});

describe('run retention, in-memory fallback', () => {
  it('keeps the newest N and drops runs past the TTL', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.OASIS_WORKFLOW_MAX_RUNS = '3';
    process.env.OASIS_WORKFLOW_RUN_TTL_DAYS = '10';
    const store = new WorkflowStore();
    await waitReady(store, false);
    await store.saveRun(run('old', 11 * DAY));
    for (let i = 0; i < 4; i++) await store.saveRun(run(`r${i}`, (4 - i) * 1000));
    await store.saveRun(run('other', 0, 'wf2'));
    const ids = (await store.listRuns('wf1', 50)).map(r => r.run_id);
    expect(ids).toEqual(['r3', 'r2', 'r1']);
    expect(await store.listRuns('wf2')).toHaveLength(1);
    expect(await store.sweepRuns('wf1')).toEqual({ workflow_id: 'wf1', removed: 0, kept: 3 });
    await store.onModuleDestroy();
  });
});

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
(REDIS_TEST_URL ? describe : describe.skip)('run retention, Redis', () => {
  let admin: Redis;
  let store: WorkflowStore;

  beforeEach(async () => {
    admin = new Redis(REDIS_TEST_URL!);
    await admin.flushdb();
    process.env.REDIS_URL = REDIS_TEST_URL;
    process.env.OASIS_WORKFLOW_MAX_RUNS = '3';
    process.env.OASIS_WORKFLOW_RUN_TTL_DAYS = '10';
    store = new WorkflowStore();
    await waitReady(store, true);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await admin.quit();
  });

  it('sets a TTL on new runs and their streams', async () => {
    await store.saveRun(run('a', 0));
    await store.appendRunEvent('a', 'node_started', { node: 'x' });
    const ttl = await admin.ttl('wf:run:a');
    expect(ttl).toBeGreaterThan(9 * 86_400);
    expect(ttl).toBeLessThanOrEqual(10 * 86_400);
    expect(await admin.ttl('wf:stream:a')).toBeGreaterThan(9 * 86_400);
  });

  it('pruning deletes the doc and stream of runs past the cap or TTL', async () => {
    await store.saveRun(run('old', 11 * DAY));
    await store.appendRunEvent('old', 'e', {});
    for (let i = 0; i < 4; i++) {
      await store.saveRun(run(`r${i}`, (4 - i) * 1000));
      await store.appendRunEvent(`r${i}`, 'e', {});
    }
    expect(await admin.zrange('wf:runs:by-workflow:wf1', 0, -1)).toEqual(['r1', 'r2', 'r3']);
    // r0 was pruned when r3 arrived: doc and stream both gone.
    expect(await admin.exists('wf:run:r0', 'wf:stream:r0')).toBe(0);
    // `old` was past the TTL when saved, so it was pruned at once; the event written after
    // that recreated its stream, which still expires instead of lingering.
    expect(await admin.exists('wf:run:old')).toBe(0);
    expect(await admin.ttl('wf:stream:old')).toBeGreaterThan(0);
    expect(await admin.exists('wf:run:r3', 'wf:stream:r3')).toBe(2);
  });

  it('a sweep drops index entries whose run already expired', async () => {
    await store.saveRun(run('a', 0));
    await store.saveRun(run('b', 0));
    await admin.del('wf:run:a');  // as if its TTL had run out
    expect(await store.sweepRuns('wf1')).toEqual({ workflow_id: 'wf1', removed: 1, kept: 1 });
    expect(await admin.zrange('wf:runs:by-workflow:wf1', 0, -1)).toEqual(['b']);
    expect(await store.workflowIdsWithRuns()).toEqual(['wf1']);
  });
});
