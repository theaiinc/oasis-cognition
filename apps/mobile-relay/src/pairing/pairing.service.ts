import axios from 'axios';
import { SessionService } from '../session/session.service';
import {
  InitiatePairingRequest,
  InitiatePairingResponse,
  CompletePairingResponse,
  PairingStatusResponse,
} from './pairing.types';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const RELAY_PORT = parseInt(process.env.MOBILE_RELAY_PORT || '8015', 10);

export class PairingService {
  constructor(private readonly sessionService: SessionService) {
    // When session expires, tear down the tunnel
    this.sessionService.setOnSessionExpired(() => this.stopTunnel());
  }

  async initiate(req: InitiatePairingRequest): Promise<InitiatePairingResponse> {
    // Start or reuse Cloudflare tunnel
    const tunnelUrl = await this.startTunnel();

    const { pairingId, desktopHalf, expiresAt } = this.sessionService.initiatePairing(
      tunnelUrl,
      req.duration_hours,
    );

    const expiresEpoch = Math.floor(expiresAt.getTime() / 1000);
    const qrUrl = `${tunnelUrl}/#pair/${pairingId}/${desktopHalf.encoded}/${expiresEpoch}`;

    return {
      pairing_id: pairingId,
      qr_url: qrUrl,
      expires_at: expiresAt.toISOString(),
      tunnel_url: tunnelUrl,
    };
  }

  complete(pairingId: string, mobileHalfKey: string): CompletePairingResponse {
    const { mobileSessionId } = this.sessionService.completePairing(pairingId, mobileHalfKey);
    const session = this.sessionService.getSession()!;

    return {
      mobile_session_id: mobileSessionId,
      expires_at: session.expiresAt.toISOString(),
    };
  }

  revoke(): void {
    this.sessionService.revoke();
    this.stopTunnel().catch((err) =>
      console.warn('[PairingService] Failed to stop tunnel on revoke:', err.message),
    );
  }

  getStatus(): PairingStatusResponse {
    const state = this.sessionService.getState();
    const session = this.sessionService.getSession();

    const base: PairingStatusResponse = { state };

    if (session) {
      base.pairing_id = session.pairingId;
      base.expires_at = session.expiresAt.toISOString();
      base.tunnel_url = session.tunnelUrl;
      base.screen_share_granted = session.screenShareGranted;
      base.last_tool_request = session.lastToolRequest
        ? {
            type: session.lastToolRequest.type,
            timestamp: session.lastToolRequest.timestamp.toISOString(),
            status: session.lastToolRequest.status,
          }
        : null;
    }

    return base;
  }

  setScreenAccess(grant: boolean): void {
    this.sessionService.setScreenShareGranted(grant);
  }

  private async startTunnel(): Promise<string> {
    try {
      const res = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/tunnel/start`,
        { port: RELAY_PORT },
        { timeout: 30_000 },
      );
      return res.data.url;
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message;
      throw new Error(`Failed to start Cloudflare tunnel: ${msg}`);
    }
  }

  private async stopTunnel(): Promise<void> {
    try {
      await axios.delete(`${DEV_AGENT_URL}/internal/dev-agent/tunnel/stop`, { timeout: 10_000 });
    } catch (err: any) {
      console.warn('[PairingService] Failed to stop tunnel:', err.message);
    }
  }
}
