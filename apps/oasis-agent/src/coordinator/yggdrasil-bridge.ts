import axios from 'axios';
import type { AxiosInstance } from 'axios';
import type { RunnerInfo, RunnerTask } from '@theaiinc/yggdrasil';

export interface YggHealthResponse {
  status: string;
  timestamp: string;
  version: string;
  uptime: number;
  runners: { total: number; online: number; offline: number };
}

export interface AdmissionState {
  available_slots: number;
  queue_depth: number;
  healthy_count: number;
  total_count: number;
  circuit_breaker_open: boolean;
}

const DEFAULT_CONFIG = {
  maxConcurrency: parseInt(process.env.YGGDRASIL_MAX_CONCURRENCY || '8', 10),
};

export class YggdrasilBridgeService {
  private readonly client: AxiosInstance;
  private readonly apiKey: string | undefined;

  constructor() {
    const baseURL = process.env.YGGDRASIL_URL || 'http://yggdrasil:3100';
    this.apiKey = process.env.YGGDRASIL_API_KEY || undefined;

    this.client = axios.create({
      baseURL,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      },
    });

    console.log(`Yggdrasil bridge initialised (controller=${baseURL}, apiKey=${!!this.apiKey})`);
  }

  async health(): Promise<YggHealthResponse | null> {
    try {
      const { data } = await this.client.get('/health');
      return data as YggHealthResponse;
    } catch (err: any) {
      console.warn(`Yggdrasil health check failed: ${err.message}`);
      return null;
    }
  }

  async registerRunner(opts: {
    runnerId?: string;
    name?: string;
    endpoint?: string;
    capabilities?: string[];
    labels?: Record<string, string>;
    resources?: RunnerInfo['resources'];
  }): Promise<{ runnerId: string }> {
    const { data } = await this.client.post('/runners/register', opts);
    return data as { runnerId: string };
  }

  async sendHeartbeat(
    runnerId: string,
    resources?: RunnerInfo['resources'],
    tasks?: RunnerTask[],
  ): Promise<void> {
    await this.client.post('/runners/heartbeat', { runnerId, resources, tasks });
  }

  async markOffline(runnerId: string): Promise<void> {
    await this.client.post('/runners/offline', { runnerId });
  }

  async updateRunnerEndpoint(runnerId: string, newEndpoint: string): Promise<void> {
    await this.client.post('/runners/update', { runnerId, newEndpoint });
  }

  async getRunner(runnerId: string): Promise<RunnerInfo | null> {
    try {
      const { data } = await this.client.get(`/api/runners/${runnerId}`);
      return data as RunnerInfo;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      console.warn(`getRunner(${runnerId}) failed: ${err.message}`);
      return null;
    }
  }

  async listRunners(): Promise<RunnerInfo[]> {
    try {
      const { data } = await this.client.get('/api/runners');
      return (data?.runners ?? []) as RunnerInfo[];
    } catch (err: any) {
      console.warn(`listRunners failed: ${err.message}`);
      return [];
    }
  }

  static readonly AGENT_TASK_TYPE = 'agent' as const;
  static readonly SHELL_TASK_TYPE = 'shell' as const;

  async dispatchTask(opts: {
    goal: string;
    jobId: string;
    taskId: string;
    type?: string;
    profileId?: string;
    correlationId?: string;
    requiredCapability?: string;
  }): Promise<{ runnerId: string; taskId: string } | null> {
    const requiredCapability = opts.requiredCapability || 'agent';
    const runners = await this.listRunners();
    const online = runners.filter(
      (r) => r.status === 'online' && r.capabilities.includes(requiredCapability),
    );

    if (online.length === 0) {
      console.warn(`No online runners with capability "${requiredCapability}"`);
      return null;
    }

    const runner = online.sort(
      (a, b) =>
        a.tasks.filter((t) => t.status === 'running').length -
        b.tasks.filter((t) => t.status === 'running').length,
    )[0];

    const task = await this.createRunnerTask(runner.runnerId, {
      taskId: opts.taskId,
      type: opts.type || 'agent',
      correlationId: opts.correlationId || opts.jobId,
      metadata: {
        goal: opts.goal,
        jobId: opts.jobId,
        taskId: opts.taskId,
        profileId: opts.profileId,
      },
    });

    if (!task) {
      console.warn(`Failed to create task on runner ${runner.runnerId}`);
      return null;
    }

    console.log(`Dispatched task ${task.taskId} (type=${task.type}) to runner ${runner.runnerId} (${runner.name})`);
    return { runnerId: runner.runnerId, taskId: task.taskId };
  }

  async waitForTask(
    runnerId: string,
    taskId: string,
    pollIntervalMs = 2000,
    timeoutMs = 300_000,
  ): Promise<{ status: string; metadata?: Record<string, unknown>; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tasks = await this.listRunnerTasks(runnerId, 'running');
      const task = tasks.find((t) => t.taskId === taskId);

      if (!task) {
        const allTasks = await this.listRunnerTasks(runnerId);
        const found = allTasks.find((t) => t.taskId === taskId);
        if (!found) {
          return { status: 'unknown', error: 'Task not found' };
        }
        if (found.status === 'completed') {
          return { status: 'completed', metadata: found.metadata };
        }
        if (found.status === 'failed') {
          return { status: 'failed', error: 'Runner reported task failure', metadata: found.metadata };
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    console.warn(`waitForTask(${taskId}) timed out after ${timeoutMs}ms`);
    return { status: 'timeout', error: `Task did not complete within ${timeoutMs}ms` };
  }

  async createRunnerTask(
    runnerId: string,
    task: { taskId?: string; type?: string; correlationId?: string; metadata?: Record<string, unknown> },
  ): Promise<RunnerTask | null> {
    try {
      const { data } = await this.client.post(`/runners/${runnerId}/tasks`, task);
      return data as RunnerTask;
    } catch (err: any) {
      console.warn(`createRunnerTask(${runnerId}) failed: ${err.message}`);
      return null;
    }
  }

  async updateRunnerTask(
    runnerId: string,
    taskId: string,
    patch: { status?: string; metadata?: Record<string, unknown> },
  ): Promise<RunnerTask | null> {
    try {
      const { data } = await this.client.patch(`/runners/${runnerId}/tasks/${taskId}`, patch);
      return data as RunnerTask;
    } catch (err: any) {
      console.warn(`updateRunnerTask(${runnerId}, ${taskId}) failed: ${err.message}`);
      return null;
    }
  }

  async listRunnerTasks(runnerId: string, status?: string): Promise<RunnerTask[]> {
    try {
      const params = status ? { status } : {};
      const { data } = await this.client.get(`/runners/${runnerId}/tasks`, { params });
      return (data?.tasks ?? []) as RunnerTask[];
    } catch (err: any) {
      console.warn(`listRunnerTasks(${runnerId}) failed: ${err.message}`);
      return [];
    }
  }

  async getAdmissionState(): Promise<AdmissionState> {
    try {
      const runners = await this.listRunners();
      const online = runners.filter((r) => r.status === 'online');
      const total = runners.length;

      return {
        available_slots: Math.max(0, DEFAULT_CONFIG.maxConcurrency - total),
        queue_depth: 0,
        healthy_count: online.length,
        total_count: total,
        circuit_breaker_open: total > 0 && online.length === 0,
      };
    } catch (err: any) {
      console.warn(`getAdmissionState failed, returning defaults: ${err.message}`);
      return {
        available_slots: DEFAULT_CONFIG.maxConcurrency,
        queue_depth: 0,
        healthy_count: 0,
        total_count: 0,
        circuit_breaker_open: false,
      };
    }
  }
}
