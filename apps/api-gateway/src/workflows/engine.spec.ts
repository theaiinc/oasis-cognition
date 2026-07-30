import { executeRun } from './engine';
import { registerNode } from './node-registry';
import type { Workflow, WorkflowRun } from './workflows.types';

describe('workflow engine', () => {
  it('executes ready nodes in later batches when concurrency is limited', async () => {
    let active = 0;
    let peak = 0;
    registerNode('test_concurrency' as any, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return { out: true };
    });

    const workflow: Workflow = {
      workflow_id: 'wf-test',
      name: 'test',
      version: 1,
      enabled: true,
      nodes: [
        { id: 'a', type: 'test_concurrency' as any, params: {} },
        { id: 'b', type: 'test_concurrency' as any, params: {} },
        { id: 'c', type: 'test_concurrency' as any, params: {} },
      ],
      edges: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const run: WorkflowRun = {
      run_id: 'run-test',
      workflow_id: workflow.workflow_id,
      status: 'queued',
      context: {},
      node_states: {},
      created_at: new Date().toISOString(),
    };
    const store = {
      saveRun: jest.fn(async () => undefined),
      appendRunEvent: jest.fn(async () => undefined),
    } as any;

    const result = await executeRun(run, workflow, store, { maxConcurrency: 1 });

    expect(result.status).toBe('completed');
    expect(Object.values(result.node_states).every(s => s.status === 'completed')).toBe(true);
    expect(peak).toBe(1);
  });
});
