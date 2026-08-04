/**
 * Oasis Agent Client — typed HTTP client for the oasis-agent service.
 *
 * Usage:
 *   ```ts
 *   const client = new OasisAgentClient({ baseUrl: 'http://oasis-agent:8020' });
 *
 *   // Coordinator: create a job
 *   const { job_id } = await client.createJob(plan, sessionId, interactionId);
 *
 *   // External agents: start a claude-code session
 *   const session = await client.createAgentSession({ goal: '...', agent_type: 'claude-code' });
 *
 *   // Dev-agent proxy: execute a computer action
 *   const result = await client.executeDevAgent({ tool: 'computer_action', action: 'screenshot' });
 *   ```
 */

import axios, { type AxiosInstance } from 'axios';
import type {
  CoordinatorJob,
  PlannerPlan,
  JobBudget,
  JobUsage,
  HostCapacitySnapshot,
  CreateJobResult,
  ExternalAgentSession,
  CreateAgentSessionRequest,
  NormalizedEvent,
  AdmissionState,
  DevAgentExecuteRequest,
  DevAgentExecuteResponse,
} from './types';

export interface OasisAgentClientOptions {
  /** Base URL of the oasis-agent service (default: http://localhost:8020). */
  baseUrl?: string;
  /** Optional API key sent as x-api-key header. */
  apiKey?: string;
  /** Axios request timeout in ms (default: 30000). */
  timeout?: number;
}

export class OasisAgentClient {
  private readonly http: AxiosInstance;

  constructor(options: OasisAgentClientOptions = {}) {
    const baseURL = options.baseUrl || 'http://localhost:8020';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.apiKey) {
      headers['x-api-key'] = options.apiKey;
    }

    this.http = axios.create({
      baseURL,
      headers,
      timeout: options.timeout || 30_000,
    });
  }

  // ── Coordinator API ─────────────────────────────────────────────────────

  /**
   * Create a parallel subagent job from a planner plan.
   */
  async createJob(
    plan: PlannerPlan,
    parentSessionId: string,
    interactionId?: string,
    autoApproveFree = true,
  ): Promise<CreateJobResult> {
    const { data } = await this.http.post('/api/v1/coordinator/jobs', {
      plan,
      parent_session_id: parentSessionId,
      interaction_id: interactionId || '',
      auto_approve_free: autoApproveFree,
    });
    return data;
  }

  /**
   * List coordinator jobs, optionally filtered by parent session.
   */
  async listJobs(parentSessionId?: string): Promise<CoordinatorJob[]> {
    const params = parentSessionId ? { parent_session_id: parentSessionId } : {};
    const { data } = await this.http.get('/api/v1/coordinator/jobs', { params });
    return data;
  }

  /**
   * Get a single coordinator job by ID.
   */
  async getJob(jobId: string): Promise<CoordinatorJob> {
    const { data } = await this.http.get(`/api/v1/coordinator/jobs/${jobId}`);
    return data;
  }

  /**
   * Approve a coordinator job, starting execution.
   */
  async approveJob(jobId: string): Promise<void> {
    await this.http.post(`/api/v1/coordinator/jobs/${jobId}/approve`);
  }

  /**
   * Cancel a coordinator job.
   */
  async cancelJob(jobId: string): Promise<void> {
    await this.http.delete(`/api/v1/coordinator/jobs/${jobId}`);
  }

  /**
   * Get the budget for a coordinator job.
   */
  async getJobBudget(jobId: string): Promise<JobBudget> {
    const { data } = await this.http.get(`/api/v1/coordinator/jobs/${jobId}/budget`);
    return data;
  }

  /**
   * Update the budget for a coordinator job (override max USD).
   */
  async updateJobBudget(jobId: string, maxUsd: number): Promise<JobBudget> {
    const { data } = await this.http.patch(`/api/v1/coordinator/jobs/${jobId}/budget`, { max_usd: maxUsd });
    return data;
  }

  /**
   * Get usage/cost tracking for a coordinator job.
   */
  async getJobUsage(jobId: string): Promise<JobUsage> {
    const { data } = await this.http.get(`/api/v1/coordinator/jobs/${jobId}/usage`);
    return data;
  }

  /**
   * Get current host capacity snapshot.
   */
  async getHostCapacity(): Promise<HostCapacitySnapshot> {
    const { data } = await this.http.get('/api/v1/coordinator/capacity');
    return data;
  }

  /**
   * Get Yggdrasil admission state.
   */
  async getAdmissionState(): Promise<AdmissionState> {
    const { data } = await this.http.get('/api/v1/coordinator/admission');
    return data;
  }

  // ── External Agents API ─────────────────────────────────────────────────

  /**
   * Create an external agent session (Claude Code / Cursor CLI).
   */
  async createAgentSession(req: CreateAgentSessionRequest): Promise<ExternalAgentSession> {
    const { data } = await this.http.post('/api/v1/agents/sessions', req);
    return data;
  }

  /**
   * List external agent sessions.
   */
  async listAgentSessions(): Promise<ExternalAgentSession[]> {
    const { data } = await this.http.get('/api/v1/agents/sessions');
    return data;
  }

  /**
   * Get a single external agent session.
   */
  async getAgentSession(sessionId: string): Promise<ExternalAgentSession> {
    const { data } = await this.http.get(`/api/v1/agents/sessions/${sessionId}`);
    return data;
  }

  /**
   * Cancel an external agent session.
   */
  async cancelAgentSession(sessionId: string): Promise<void> {
    await this.http.delete(`/api/v1/agents/sessions/${sessionId}`);
  }

  /**
   * Get the transcript for an external agent session.
   */
  async getAgentTranscript(sessionId: string): Promise<NormalizedEvent[]> {
    const { data } = await this.http.get(`/api/v1/agents/sessions/${sessionId}/transcript`);
    return data;
  }

  // ── Dev-Agent Proxy API ─────────────────────────────────────────────────

  /**
   * Execute a computer action via the dev-agent proxy.
   */
  async executeDevAgent(payload: DevAgentExecuteRequest): Promise<DevAgentExecuteResponse> {
    const { data } = await this.http.post('/api/v1/internal/dev-agent/execute', payload, {
      timeout: 120_000,
    });
    return data;
  }

  // ── Health ───────────────────────────────────────────────────────────────

  /**
   * Check if the oasis-agent service is healthy.
   */
  async health(): Promise<{ status: string; service: string; timestamp: string }> {
    const { data } = await this.http.get('/health');
    return data;
  }
}
