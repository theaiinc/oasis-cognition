/**
 * Container backend — implements WorkerBackend against Docker containers.
 *
 * Each subagent runs in its own ephemeral container (same image as the
 * dev-agent or a dedicated agent-runner image). Containers are managed
 * via Dockerode and registered as Yggdrasil workers.
 *
 * This is the v2 worker backend, activated when the Docker agent pool
 * compose profile is running.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CoordinatorTask, WorkerBackend } from './coordinator.types';

/** Lightweight wrapper around a Dockerode container handle. */
export interface ContainerHandle {
  containerId: string;
  taskId: string;
  image: string;
  startedAt: string;
}

@Injectable()
export class ContainerBackend implements WorkerBackend {
  private readonly logger = new Logger(ContainerBackend.name);

  /** Docker socket path — overridable via env. */
  private readonly DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  /** Default agent image — overridable so users can pin a specific tag. */
  private readonly AGENT_IMAGE = process.env.AGENT_POOL_IMAGE || 'oasis-agent-runner:latest';
  /** Network to attach containers to (must be the compose network). */
  private readonly NETWORK = process.env.COMPOSE_NETWORK || 'oasis-cognition_default';
  /** Max time to wait for a container to become healthy. */
  private readonly STARTUP_TIMEOUT_MS = parseInt(process.env.AGENT_CONTAINER_STARTUP_TIMEOUT_MS || '30000', 10);

  /** Track running containers so we can check/kill them. */
  private readonly handles = new Map<string, ContainerHandle>();

  /** Lazily-initialised Dockerode client. */
  private _docker: any | null = null;

  private async docker(): Promise<any> {
    if (this._docker) return this._docker;
    try {
      const dockerodeModule = await import('dockerode');
      const Docker = (dockerodeModule as any).default || dockerodeModule;
      this._docker = new Docker({ socketPath: this.DOCKER_SOCKET });
      this.logger.log(`ContainerBackend: Docker client initialised (socket=${this.DOCKER_SOCKET})`);
    } catch (err: any) {
      this.logger.error(`ContainerBackend: dockerode import failed — ${err.message}. Using stub mode.`);
      // Provide a minimal stub so the app doesn't crash on startup
      this._docker = null;
    }
    return this._docker;
  }

  async spawn(sessionId: string, task: CoordinatorTask, parentJobId: string): Promise<string> {
    const client = await this.docker();
    if (!client) {
      // Stub fallback when Docker is not available
      this.logger.warn(`ContainerBackend.spawn: Docker unavailable, returning stub handle for task=${task.id}`);
      return `stub-container-${task.id}-${Date.now()}`;
    }

    this.logger.log(`ContainerBackend.spawn: starting container for task=${task.id}, image=${this.AGENT_IMAGE}`);

    const envVars = [
      `OASIS_AGENT_GOAL=${task.goal}`,
      `OASIS_PARENT_JOB_ID=${parentJobId}`,
      `OASIS_TASK_ID=${task.id}`,
      `OASIS_SESSION_ID=${sessionId}`,
      `OASIS_PROFILE_ID=${task.profile_id || ''}`,
      // Pass through proxy / gateway URL so the container can report back
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
            // Mount the workspace so the container can read/write files
            `${process.env.PROJECT_ROOT || '/workspace'}:/workspace:rw`,
          ],
          Memory: 1024 * 1024 * 1024, // 1GB per container
          MemorySwap: 0,               // no swap
          CpuShares: 512,              // relative CPU weight
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

      this.logger.log(`ContainerBackend: started ${container.id} (name=${containerName}, image=${this.AGENT_IMAGE})`);
      return container.id;
    } catch (err: any) {
      this.logger.error(`ContainerBackend.spawn failed for task=${task.id}: ${err.message}`);
      throw err;
    }
  }

  async checkStatus(handle: string): Promise<{ done: boolean; error?: string }> {
    // Stub handles are always "done"
    if (handle.startsWith('stub-')) {
      return { done: true };
    }

    const client = await this.docker();
    if (!client) return { done: true };

    try {
      const container = client.getContainer(handle);
      const info = await container.inspect();

      // Started but no exit yet → still running
      if (info.State.Running) {
        return { done: false };
      }

      const exitCode = info.State.ExitCode;
      const error = exitCode !== 0 ? `Container exited with code ${exitCode}` : undefined;

      // Remove from tracking once done
      this.handles.delete(handle);

      return { done: true, error };
    } catch (err: any) {
      // Container no longer exists → assume done
      if (err.statusCode === 404) {
        this.handles.delete(handle);
        return { done: true };
      }
      this.logger.warn(`ContainerBackend.checkStatus(${handle}): ${err.message}`);
      return { done: false };
    }
  }

  async kill(handle: string): Promise<void> {
    if (handle.startsWith('stub-')) {
      return;
    }

    const client = await this.docker();
    if (!client) return;

    try {
      const container = client.getContainer(handle);
      await container.stop({ t: 5 }); // 5s grace before SIGKILL
      await container.remove({ force: true });
      this.handles.delete(handle);
      this.logger.log(`ContainerBackend: killed ${handle}`);
    } catch (err: any) {
      if (err.statusCode === 304) {
        // Already stopped — still remove
        try {
          const container = client.getContainer(handle);
          await container.remove({ force: true });
        } catch { /* best-effort */ }
      } else if (err.statusCode !== 404) {
        this.logger.warn(`ContainerBackend.kill(${handle}): ${err.message}`);
      }
      this.handles.delete(handle);
    }
  }

  estimateCost(task: CoordinatorTask): { usd_low: number; usd_high: number; tokens_low: number; tokens_high: number } {
    // Containers are fixed-cost per run (image + runtime)
    const runtimeMinutes = Math.max(1, Math.ceil((task.goal?.length ?? 0) / 500));
    // At roughly $0.10/min estimated container runtime cost (compute + pull)
    const baseCost = runtimeMinutes * 0.10 * 60; // hours * hourly rate
    return {
      usd_low: task.est_cost_usd ? task.est_cost_usd * 0.5 : baseCost * 0.5,
      usd_high: task.est_cost_usd ?? baseCost * 1.5,
      tokens_low: 0,
      tokens_high: 0,
    };
  }

  /** List all tracked container handles (for observability / dashboard). */
  listContainers(): ContainerHandle[] {
    return Array.from(this.handles.values());
  }

  /** Clean up all tracked containers (e.g. on shutdown). */
  async killAll(): Promise<void> {
    const ids = Array.from(this.handles.keys());
    this.logger.log(`ContainerBackend: killing all ${ids.length} tracked containers`);
    await Promise.allSettled(ids.map(id => this.kill(id)));
  }
}
