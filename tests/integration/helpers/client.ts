/**
 * Typed HTTP client for integration tests.
 * Uses the contract schemas from @oasis/gateway-contracts for response validation.
 */
import axios from 'axios';
import type { z } from 'zod';
import { ZodError } from 'zod';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8000';
const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';

export interface InteractionResponse {
  response: string;
  confidence?: number;
  reasoning_graph?: Record<string, unknown>;
  reasoning_trace?: string[];
  route?: string;
}

interface AcceptedInteraction {
  session_id: string;
}

// Retry config for transient LLM provider hiccups
const INTERACT_RETRIES = 3;
const INTERACT_RETRY_DELAY_MS = 5000;

export class TestClient {
  readonly sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `test-${crypto.randomUUID?.() || Math.random().toString(36).substring(2)}`;
  }

  /**
   * Send a user message to the gateway interaction endpoint.
   * Retries on transient failures (5xx, network errors) with backoff.
   * This is the main entry point that exercises the full pipeline.
   */
  async interact(message: string, options?: {
    projectId?: string;
    roleId?: string;
  }): Promise<InteractionResponse> {
    let lastError: Error | undefined;
    const clientMessageId = `integration-${crypto.randomUUID?.() || Math.random().toString(36).substring(2)}`;

    for (let attempt = 1; attempt <= INTERACT_RETRIES; attempt++) {
      try {
        const response = await fetch(`${GATEWAY_URL}/api/v1/interaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_message: message,
            session_id: this.sessionId,
            context: {
              source: 'integration-test',
              project_id: options?.projectId,
              client_message_id: clientMessageId,
            },
            role_id: options?.roleId,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Interaction failed (${response.status}): ${text.slice(0, 500)}`);
        }

        const accepted = await response.json() as AcceptedInteraction;
        if (typeof accepted.session_id !== 'string' || accepted.session_id !== this.sessionId) {
          throw new Error(`Interaction returned unexpected acceptance: ${JSON.stringify(accepted)}`);
        }
        return await this.waitForResponse(clientMessageId);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isTransient =
          lastError.message.includes('5') ||
          lastError.message.includes('ECONNRESET') ||
          lastError.message.includes('ECONNREFUSED') ||
          lastError.message.includes('ETIMEDOUT') ||
          lastError.message.includes('fetch failed') ||
          lastError.message.includes('Pipeline failed');
        if (attempt < INTERACT_RETRIES && isTransient) {
          const delay = INTERACT_RETRY_DELAY_MS * attempt;
          console.log(`[retry] Interaction attempt ${attempt}/${INTERACT_RETRIES} failed: ${lastError.message.slice(0, 100)}, retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  private async waitForResponse(clientMessageId: string, timeoutMs = 120_000): Promise<InteractionResponse> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = await this.getHistory();
      const message = [...history.messages].reverse().find((item) =>
        item.role === 'assistant' && (item as { client_message_id?: string }).client_message_id === clientMessageId,
      ) as ({ content?: string; confidence?: number; reasoning_graph?: Record<string, unknown>; reasoning_trace?: string[]; route?: string } | undefined);
      if (message) {
        return {
          response: message.content || '',
          confidence: message.confidence,
          reasoning_graph: message.reasoning_graph,
          reasoning_trace: message.reasoning_trace,
          route: message.route,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for assistant response ${clientMessageId}`);
  }

  /**
   * Get chat history for this session.
   */
  async getHistory(page = 0, limit = 50) {
    const res = await axios.get(`${GATEWAY_URL}/api/v1/history/messages`, {
      params: { session_id: this.sessionId, page, limit },
      timeout: 5000,
    });
    return res.data as {
      messages: Array<{ role: string; content: string; timestamp: string }>;
      total: number;
      has_more: boolean;
    };
  }

  /**
   * Create a project via the gateway.
   */
  async createProject(name: string, description: string, projectPath: string) {
    const res = await axios.post(`${MEMORY_URL}/internal/memory/projects`, {
      name,
      description,
      project_path: projectPath,
    }, { timeout: 5000 });
    // Response is { status: "ok", project: { project_id, name, ... } }
    const body = res.data as { status: string; project?: { project_id: string } };
    if (!body.project || !body.project.project_id) {
      throw new Error(`createProject returned unexpected shape: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return { project_id: body.project.project_id };
  }

  /**
   * Validate a response against a Zod schema.
   */
  validateResponse<T>(schema: z.ZodType<T>, data: unknown): T {
    try {
      return schema.parse(data);
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.slice(0, 5)
          .map(i => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n');
        throw new Error(`Response validation failed:\n${issues}`);
      }
      throw err;
    }
  }
}
