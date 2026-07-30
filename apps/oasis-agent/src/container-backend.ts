import type { CoordinatorTask, WorkerBackend } from './coordinator/types';

export interface ContainerHandle {
  containerId: string;
  taskId: string;
  image: string;
  startedAt: string;
}

export class ContainerBackend implements WorkerBackend {
  private readonly DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  private readonly AGENT_IMAGE = process.env.AGENT_POOL_IMAGE || 'oasis-agent-runner:latest';
  private readonly NETWORK = process.env.COMPOSE_NETWORK || 'oasis-cognition_default';
  private readonly STARTUP_TIMEOUT_MS = parseInt(process.env.AGENT_CONTAINER_STARTUP_TIMEOUT_MS || '30000', 10);

  private readonly handles = new Map<string, ContainerHandle>();
  private _docker: any | null = null;

  private async docker(): Promise<any> {
    if (this._docker) return this._docker;
    try {
      const dockerodeModule = await import('dockerode');
      const Docker = (dockerodeModule as any).default || dockerodeModule;
      this._docker = new Docker({ socketPath: this.DOCKER_SOCKET });
      console.log(`ContainerBackend: Docker client initialised (socket=${this.DOCKER_SOCKET})`);
    } catch (err: any) {
      console.error(`ContainerBackend: dockerode import failed — ${err.message}. Using stub mode.`);
      this._docker = null;
    }
    return this._docker;
  }

  async spawn(sessionId: string, task: CoordinatorTask, parentJobId: string): Promise<string> {
    const client = await this.docker();
    if (!client) {
      console.warn(`ContainerBackend.spawn: Docker unavailable, returning stub handle for task=${task.id}`);
      return `stub-container-${task.id}-${Date.now()}`;
    }

    console.log(`ContainerBackend.spawn: starting container for task=${task.id}, image=${this.AGENT_IMAGE}`);

    const envVars = [
      `OASIS_AGENT_GOAL=${task.goal}`,
      `OASIS_PARENT_JOB_ID=${parentJobId}`,
      `OASIS_TASK_ID=${task.id}`,
      `OASIS_SESSION_ID=${sessionId}`,
      `OASIS_PROFILE_ID=${task.profile_id || ''}`,
      `OASIS_GATEWAY_URL=http://api-gateway:8000`,
    ];

    const containerName = `oasis-agent-${task.id}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    try {
      const container = await client.createContainer({
        Image: this.AGENT_IMAGE,
        name: containerName,
        Env: envVars,
        HostConfig: {
          NetworkMode: this.NETWORK,
          AutoRemove: true,
          Binds: [
            `${process.env.PROJECT_ROOT || '/workspace'}:/workspace:rw`,
          ],
          Memory: 1024 * 1024 * 1024,
          MemorySwap: 0,
          CpuShares: 512,
        },
        AttachStdout: false,
        AttachStderr: false,
      });

      await container.start();

      const handle: ContainerHandle = {
        containerId: container.id,
        taskId: task.id,
        image: this.AGENT_IMAGE,
        startedAt: new Date().toISOString(),
      };
      this.handles.set(container.id, handle);

      console.log(`ContainerBackend: started ${container.id} (name=${containerName}, image=${this.AGENT_IMAGE})`);
      return container.id;
    } catch (err: any) {
      console.error(`ContainerBackend.spawn failed for task=${task.id}: ${err.message}`);
      throw err;
    }
  }

  async checkStatus(handle: string): Promise<{ done: boolean; error?: string }> {
    if (handle.startsWith('stub-')) {
      return { done: true };
    }

    const client = await this.docker();
    if (!client) return { done: true };

    try {
      const container = client.getContainer(handle);
      const info = await container.inspect();

      if (info.State.Running) {
        return { done: false };
      }

      const exitCode = info.State.ExitCode;
      const error = exitCode !== 0 ? `Container exited with code ${exitCode}` : undefined;
      this.handles.delete(handle);
      return { done: true, error };
    } catch (err: any) {
      if (err.statusCode === 404) {
        this.handles.delete(handle);
        return { done: true };
      }
      console.warn(`ContainerBackend.checkStatus(${handle}): ${err.message}`);
      return { done: false };
    }
  }

  async kill(handle: string): Promise<void> {
    if (handle.startsWith('stub-')) return;

    const client = await this.docker();
    if (!client) return;

    try {
      const container = client.getContainer(handle);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
      this.handles.delete(handle);
      console.log(`ContainerBackend: killed ${handle}`);
    } catch (err: any) {
      if (err.statusCode === 304) {
        try {
          const container = client.getContainer(handle);
          await container.remove({ force: true });
        } catch { /* best-effort */ }
      } else if (err.statusCode !== 404) {
        console.warn(`ContainerBackend.kill(${handle}): ${err.message}`);
      }
      this.handles.delete(handle);
    }
  }

  estimateCost(task: CoordinatorTask): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number } {
    const runtimeMinutes = Math.max(1, Math.ceil((task.goal?.length ?? 0) / 500));
    const baseCost = runtimeMinutes * 0.10 * 60;
    return {
      usd_low: task.est_cost_usd ? task.est_cost_usd * 0.5 : baseCost * 0.5,
      usd_high: task.est_cost_usd ?? baseCost * 1.5,
      tokens_low: 0,
      tokens_high: 0,
    };
  }

  listContainers(): ContainerHandle[] {
    return Array.from(this.handles.values());
  }

  async killAll(): Promise<void> {
    const ids = Array.from(this.handles.keys());
    console.log(`ContainerBackend: killing all ${ids.length} tracked containers`);
    await Promise.allSettled(ids.map(id => this.kill(id)));
  }
}
