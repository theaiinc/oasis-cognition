import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { GATEWAY_URL } from '../gateway';
import { followTurn, FollowOptions, FollowResult } from './timeline-follower';
import { SessionService } from '../session/session.service';
import { encrypt, decrypt } from '../crypto/crypto.service';
import { EncryptedPayload } from '../crypto/crypto.types';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://127.0.0.1:8008';
/** A Redis stream id, the gateway's event cursor. */
const CURSOR = /^\d+-\d+$/;


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
   * Send the phone's message to the gateway and stream the turn back.
   *
   * The gateway accepts a message with 202 and a replay cursor, then runs the
   * turn in the background and publishes its progress on the timeline. We follow
   * the timeline from that cursor (see followTurn) and write each event to the
   * phone as one encrypted NDJSON line, each carrying `_cursor`, then a final line
   * with the response (or `_oasis_error`).
   *
   * A phone that lost the stream sends the same message again, with the same
   * client_message_id and `resume_after` set to the last `_cursor` it got: the
   * gateway recognises the id and starts no second turn, and we replay from
   * that cursor, so the phone sees every event once.
   */
  async streamInteraction(
    decryptedBody: any,
    pairingId: string,
    mobileSessionId: string,
    writeEncryptedLine: (payload: EncryptedPayload) => void,
    onDone: () => void,
    signal: AbortSignal = new AbortController().signal,
    follow: (opts: FollowOptions) => Promise<FollowResult> = followTurn,
  ): Promise<void> {
    const { resume_after: resumeAfterRaw, ...body } = decryptedBody || {};
    const resumeAfter = typeof resumeAfterRaw === 'string' && CURSOR.test(resumeAfterRaw) ? resumeAfterRaw : null;
    const clientMessageId = typeof body.context?.client_message_id === 'string' && body.context.client_message_id
      ? body.context.client_message_id
      : uuidv4();
    const gatewayBody = {
      ...body,
      session_id: mobileSessionId,
      context: { ...body.context, source: 'mobile-companion', client_message_id: clientMessageId },
    };
    const send = (obj: Record<string, unknown>) => {
      try {
        writeEncryptedLine(this.encryptResponse(JSON.stringify(obj), pairingId));
      } catch (err) {
        console.warn('[Relay] Failed to encrypt line:', (err as Error).message);
      }
    };

    try {
      let accepted: { event_cursor?: string; duplicate?: boolean };
      try {
        const response = await axios.post(`${GATEWAY_URL}/api/v1/interaction`, gatewayBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30_000,
          signal,
        });
        accepted = response.data || {};
      } catch (err: any) {
        if (signal.aborted) return;
        const status: number | undefined = err?.response?.status;
        const detail = err?.response?.data?.message || err?.response?.data?.error;
        send({
          _oasis_error: true,
          // Network trouble or a 5xx: the same message can be sent again safely.
          retryable: !status || status >= 500,
          body: { error: typeof detail === 'string' ? detail : (status ? `Gateway refused the message (${status})` : 'Desktop is unreachable') },
        });
        return;
      }

      const startCursor = typeof accepted.event_cursor === 'string' && CURSOR.test(accepted.event_cursor) ? accepted.event_cursor : null;
      const after = resumeAfter || startCursor;
      send({ _oasis_accepted: true, client_message_id: clientMessageId, duplicate: Boolean(accepted.duplicate), _cursor: after });

      const result = await follow({
        sessionId: mobileSessionId,
        clientMessageId,
        after,
        signal,
        onEvent: (event, cursor) => send({ _mobile_event: true, event_type: event.event_type, payload: event.payload, _cursor: cursor }),
      });

      switch (result.outcome) {
        case 'completed':
          send({ session_id: mobileSessionId, client_message_id: clientMessageId, response: result.response, _cursor: result.cursor });
          break;
        case 'failed':
        case 'cancelled':
          send({ _oasis_error: true, retryable: false, body: { error: result.error }, _cursor: result.cursor });
          break;
        case 'unreachable':
        case 'timeout':
          send({ _oasis_error: true, retryable: true, body: { error: result.error }, _cursor: result.cursor });
          break;
        case 'aborted':
          break;
      }
    } finally {
      onDone();
    }
  }

  // ── Push notifications (registrations live on the gateway) ───────────────

  async getPushConfig(): Promise<{ enabled: boolean; public_key: string | null }> {
    const response = await axios.get(`${GATEWAY_URL}/api/v1/mobile-push/config`, { timeout: 10_000 });
    return { enabled: Boolean(response.data?.enabled), public_key: response.data?.public_key ?? null };
  }

  async registerPush(deviceId: string, subscription: unknown): Promise<void> {
    await axios.post(`${GATEWAY_URL}/api/v1/mobile-push/subscriptions`, { device_id: deviceId, subscription }, { timeout: 10_000 });
    this.sessionService.setPushDeviceId(deviceId);
  }

  async unregisterPush(deviceId: string): Promise<void> {
    await axios.delete(`${GATEWAY_URL}/api/v1/mobile-push/subscriptions/${encodeURIComponent(deviceId)}`, { timeout: 10_000 });
    const s = this.sessionService.getActiveSession();
    if (s?.pushDeviceId === deviceId) this.sessionService.setPushDeviceId(null);
  }

  async testPush(deviceId: string): Promise<void> {
    await axios.post(`${GATEWAY_URL}/api/v1/mobile-push/subscriptions/${encodeURIComponent(deviceId)}/test`, {}, { timeout: 15_000 });
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
  async listArtifacts(projectId?: string): Promise<any> {
    const params = projectId ? { project_id: projectId } : {};
    const response = await axios.get(`${GATEWAY_URL}/api/v1/artifacts`, {
      params,
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
   * Follow up on a completed/failed CU session with user feedback.
   * Reopens the session and continues with the correction.
   */
  async followUpComputerUseSession(sessionId: string, message: string): Promise<any> {
    const response = await axios.post(
      `${GATEWAY_URL}/api/v1/computer-use/sessions/${sessionId}/follow-up`,
      { message },
      { timeout: 15_000 },
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
