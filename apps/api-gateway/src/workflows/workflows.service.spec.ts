import { WorkflowsService } from './workflows.service';
import type { Workflow } from './workflows.types';

describe('WorkflowsService', () => {
  function workflow(enabled: boolean): Workflow {
    return {
      workflow_id: 'wf-1',
      name: 'workflow',
      version: 1,
      enabled,
      nodes: [],
      edges: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  it('rejects manual runs for disabled workflows', async () => {
    const store = {
      getWorkflow: jest.fn().mockResolvedValue(workflow(false)),
    };
    const queue = { add: jest.fn() };
    const service = new WorkflowsService(store as any, queue as any, {} as any);

    await expect(service.runNow('wf-1', {})).rejects.toMatchObject({
      status: 409,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('deletes triggers and run records before deleting the workflow', async () => {
    const wf = workflow(true);
    const store = {
      getWorkflow: jest.fn().mockResolvedValue(wf),
      listTriggers: jest.fn().mockResolvedValue([{ trigger_id: 'trigger-1' }]),
      deleteTrigger: jest.fn().mockResolvedValue(undefined),
      deleteRunsForWorkflow: jest.fn().mockResolvedValue(undefined),
      deleteWorkflow: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WorkflowsService(store as any, {} as any, {} as any);

    await service.deleteWorkflow('wf-1');

    expect(store.deleteRunsForWorkflow).toHaveBeenCalledWith('wf-1');
    expect(store.deleteWorkflow).toHaveBeenCalledWith('wf-1');
  });
});
