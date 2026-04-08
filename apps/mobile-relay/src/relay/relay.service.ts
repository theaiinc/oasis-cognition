import axios from 'axios';
import http from 'http';
import { SessionService } from '../session/session.service';
import { encrypt, decrypt } from '../crypto/crypto.service';
import { EncryptedPayload } from '../crypto/crypto.types';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8000';
const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://127.0.0.1:8008';

// Timeline event types worth forwarding to mobile
const FORWARD_EVENT_TYPES = new Set([
  'ResponseChunkGenerated',
  'ToolCallStarted',
  'ToolCallCompleted',
  'ToolReasoningChunkGenerated',
  'ThoughtChunkGenerated',
  'ThoughtLayerGenerated',
  'ThoughtsValidated',
]);

export class RelayService {
  constructor(private readonly sessionService: SessionService) {}

  decryptRequest(payload: EncryptedPayload): { body: any; session: ReturnType<SessionService['getActiveSession']> } {
    const sessionKey = this.sessionService.getSessionKeyForPairing(payload.pid);
    if (!sessionKey) {
      throw new RelayError(401, 'session_invalid', 'No active session for this pairing ID');
    }
    try {
      const plaintext = decrypt(payload, sessionKey);
      return { body: JSON.parse(plaintext), session: this.sessionService.getActiveSession()! };
    } catch (err: any) {
      if (err.message.includes('Unsupported state') || err.message.includes('unable to authenticate')) {
        throw new RelayError(400, 'decryption_failed', 'Decryption failed — invalid key or tampered payload');
      }
      throw err;
    }
  }

  encryptResponse(plaintext: string, pairingId: string): EncryptedPayload {
    const sessionKey = this.sessionService.getSessionKeyForPairing(pairingId);
    if (!sessionKey) {
      throw new RelayError(401, 'session_expired', 'Session expired during response');
    }
    return encrypt(plaintext, sessionKey, pairingId);
  }

  /**
   * Forward an interaction to the gateway with real-time streaming.
   *
   * Opens TWO channels simultaneously:
   * 1. POST /interaction (NDJSON) — the main request/response
   * 2. GET /events/timeline (SSE) — real-time streaming events (response chunks, tool calls, thinking)
   *
   * Both channels' data is encrypted and forwarded to mobile as NDJSON lines,
   * tagged with `_stream_type` so mobile can distinguish them.
   */
  async streamInteraction(
    decryptedBody: any,
    pairingId: string,
    mobileSessionId: string,
    writeEncryptedLine: (payload: EncryptedPayload) => void,
    onDone: () => void,
  ): Promise<void> {
    const gatewayBody = {
      ...decryptedBody,
      session_id: mobileSessionId,
      context: {
        ...decryptedBody.context,
        source: 'mobile-companion',
      },
    };

    // Start SSE timeline listener BEFORE sending the interaction
    // so we don't miss early events
    const sseCleanup = this.subscribeToTimeline(mobileSessionId, pairingId, writeEncryptedLine);

    try {
      const response = await axios.post(`${GATEWAY_URL}/api/v1/interaction`, gatewayBody, {
        responseType: 'stream',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        timeout: 300_000,
      });

      await new Promise<void>((resolve, reject) => {
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const encrypted = this.encryptResponse(trimmed, pairingId);
              writeEncryptedLine(encrypted);
            } catch (err) {
              console.warn('[Relay] Failed to encrypt line:', (err as Error).message);
            }
          }
        });

        response.data.on('end', () => {
          if (buffer.trim()) {
            try {
              const encrypted = this.encryptResponse(buffer.trim(), pairingId);
              writeEncryptedLine(encrypted);
            } catch { /* ignore */ }
          }
          resolve();
        });

        response.data.on('error', (err: Error) => reject(err));
      });
    } finally {
      // Close the SSE connection
      sseCleanup();
      onDone();
    }
  }

  /**
   * Subscribe to the gateway's SSE timeline for a session.
   * Forwards relevant events (response chunks, tool calls, thinking) as encrypted NDJSON lines
   * tagged with `_mobile_event: true` so the mobile client can distinguish them from the
   * final interaction response.
   *
   * Returns a cleanup function to close the SSE connection.
   */
  private subscribeToTimeline(
    sessionId: string,
    pairingId: string,
    writeEncryptedLine: (payload: EncryptedPayload) => void,
  ): () => void {
    let req: http.ClientRequest | null = null;
    let closed = false;

    const url = new URL(`${GATEWAY_URL}/api/v1/events/timeline`);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('backlog', '0');

    // Use raw http to handle SSE stream
    req = http.get(url.toString(), (res) => {
      let sseBuffer = '';

      res.on('data', (chunk: Buffer) => {
        if (closed) return;
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const event = JSON.parse(data);
            if (!FORWARD_EVENT_TYPES.has(event.event_type)) continue;

            // Tag it as a streaming event for mobile to distinguish
            const mobileEvent = {
              _mobile_event: true,
              event_type: event.event_type,
              payload: event.payload || {},
            };

            const encrypted = this.encryptResponse(JSON.stringify(mobileEvent), pairingId);
            writeEncryptedLine(encrypted);
          } catch {
            // Skip unparseable events
          }
        }
      });

      res.on('error', () => { /* ignore SSE errors */ });
    });

    req.on('error', () => { /* ignore connection errors */ });

    return () => {
      closed = true;
      if (req) {
        req.destroy();
        req = null;
      }
    };
  }

  async proxyHistory(path: string, query: Record<string, string>, pairingId: string): Promise<EncryptedPayload> {
    const url = `${GATEWAY_URL}/api/v1/history/${path}`;
    const response = await axios.get(url, { params: query, timeout: 15_000 });
    return this.encryptResponse(JSON.stringify(response.data), pairingId);
  }

  async listSessions(): Promise<any> {
    const response = await axios.get(`${GATEWAY_URL}/api/v1/history/sessions`, {
      timeout: 10_000,
    });
    return response.data;
  }

  async loadSessionMessages(sessionId: string): Promise<any> {
    const response = await axios.get(`${GATEWAY_URL}/api/v1/history/messages`, {
      params: { session_id: sessionId },
      timeout: 15_000,
    });
    return response.data;
  }

  async proxyProjectConfig(): Promise<any> {
    // Fetch config and active project in parallel
    const [configRes, activeRes] = await Promise.all([
      axios.get(`${DEV_AGENT_URL}/internal/dev-agent/project/config`, { timeout: 10_000 }),
      axios.get(`${DEV_AGENT_URL}/internal/dev-agent/project/active`, { timeout: 10_000 }).catch(() => null),
    ]);
    const data = configRes.data;
    // Merge project_id from active project so mobile can track which project is selected
    if (activeRes?.data?.project_id && data?.config) {
      data.config.project_id = activeRes.data.project_id;
    }
    return data;
  }

  /**
   * Fetch list of projects from the memory service (via API gateway).
   * Uses the same endpoint as the desktop UI so both see the same list.
   */
  async listProjects(): Promise<any> {
    const response = await axios.get(`${GATEWAY_URL}/api/v1/projects`, {
      timeout: 10_000,
    });
    // Normalize to { success: true, projects: [...] } for the mobile UI
    const data = response.data;
    if (data?.projects) {
      return { success: true, projects: data.projects };
    }
    return data;
  }

  /**
   * Switch active project via the API gateway (same flow as desktop).
   * The gateway looks up project_path from Neo4j and passes it to dev-agent.
   */
  async activateProject(projectId: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/project/activate`,
      { project_id: projectId },
      { timeout: 15_000 },
    );
    return response.data;
  }

  /**
   * Fetch list of artifacts from the gateway.
   */
  async listArtifacts(): Promise<any> {
    const response = await axios.get(`${GATEWAY_URL}/api/v1/artifacts`, {
      timeout: 10_000,
    });
    return response.data;
  }

  async executeToolRequest(
    toolRequest: { type: string; action?: string; params?: Record<string, any> },
    pairingId: string,
  ): Promise<EncryptedPayload> {
    if (!this.sessionService.isScreenShareGranted()) {
      throw new RelayError(403, 'screen_access_denied', 'Screen access has not been granted on the desktop');
    }

    this.sessionService.updateLastToolRequest({
      type: toolRequest.type,
      timestamp: new Date(),
      status: 'pending',
    });

    try {
      const response = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/tools/execute`,
        toolRequest,
        { timeout: 60_000 },
      );

      this.sessionService.updateLastToolRequest({
        type: toolRequest.type,
        timestamp: new Date(),
        status: 'completed',
      });

      return this.encryptResponse(JSON.stringify(response.data), pairingId);
    } catch (err: any) {
      this.sessionService.updateLastToolRequest({
        type: toolRequest.type,
        timestamp: new Date(),
        status: 'failed',
      });
      throw err;
    }
  }
  /**
   * Create a computer-use session for mobile screen sharing.
   */
  async startScreenShareSession(goal: string, screenImage?: string): Promise<any> {
    const body: Record<string, any> = { goal };
    if (screenImage) body.screen_image = screenImage;

    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions`,
      body,
      { timeout: 15_000 },
    );
    return response.data;
  }

  /**
   * Push a screen frame to an active computer-use session.
   */
  async pushScreenFrame(sessionId: string, image: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/screen-frame`,
      { image },
      { timeout: 3_000 },
    );
    return response.data;
  }

  /**
   * Pause/cancel a computer-use session.
   */
  async stopScreenShareSession(sessionId: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/pause`,
      {},
      { timeout: 10_000 },
    );
    return response.data;
  }

  /**
   * Get the active computer-use session (or a specific one by ID).
   * Returns session status, plan, live_screenshot, etc.
   */
  async getComputerUseSession(sessionId?: string): Promise<any> {
    if (sessionId) {
      const response = await axios.get(
        `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}`,
        { timeout: 5_000 },
      );
      return response.data;
    }
    // Get active session
    const response = await axios.get(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/active`,
      { timeout: 5_000 },
    );
    return response.data;
  }

  /**
   * Approve a computer-use session plan.
   */
  async approveComputerUseSession(sessionId: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/approve`,
      { session_id: sessionId, grant_vision: true },
      { timeout: 10_000 },
    );
    return response.data;
  }

  /**
   * Cancel a computer-use session.
   */
  async cancelComputerUseSession(sessionId: string): Promise<any> {
    const response = await axios.delete(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}`,
      { timeout: 10_000 },
    );
    return response.data;
  }

  /**
   * Pause a running computer-use session (emergency stop).
   */
  async pauseComputerUseSession(sessionId: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/pause`,
      {},
      { timeout: 10_000 },
    );
    return response.data;
  }

  /**
   * Resume a paused computer-use session.
   */
  async resumeComputerUseSession(sessionId: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/resume`,
      {},
      { timeout: 10_000 },
    );
    return response.data;
  }

  /**
   * Send steering feedback to an executing computer-use session.
   */
  async sendComputerUseFeedback(sessionId: string, message: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/feedback`,
      { message },
      { timeout: 10_000 },
    );
    return response.data;
  }

  /**
   * Take a native screenshot via dev-agent (pyautogui).
   */
  async takeScreenshot(target?: string): Promise<any> {
    // Focus window if target specified
    if (target) {
      await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/execute`,
        { tool: 'computer_action', action: 'focus_window', text: target },
        { timeout: 5_000 },
      ).catch(() => {});
    }
    const response = await axios.post(
      `${DEV_AGENT_URL}/internal/dev-agent/execute`,
      { tool: 'computer_action', action: 'screenshot' },
      { timeout: 8_000 },
    );
    return response.data;
  }
}

export class RelayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}
