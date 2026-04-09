import { v4 as uuidv4 } from 'uuid';
import { MobilePairingSession, PairingState, ToolRequestInfo } from './session.types';
import { generateHalfKey, deriveSessionKey, decodeHalfKey } from '../crypto/crypto.service';
import { HalfKey } from '../crypto/crypto.types';

const CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_DURATION_HOURS = 6;

export class SessionService {
  private session: MobilePairingSession | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private onSessionExpired: (() => void) | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.checkExpiration(), CLEANUP_INTERVAL_MS);
  }

  setOnSessionExpired(cb: () => void): void {
    this.onSessionExpired = cb;
  }

  getState(): PairingState {
    if (!this.session) return 'idle';
    if (new Date() > this.session.expiresAt) return 'expired';
    if (!this.session.mobilePaired) return 'awaiting_mobile';
    return 'paired';
  }

  getSession(): MobilePairingSession | null {
    return this.session;
  }

  getActiveSession(): MobilePairingSession | null {
    if (!this.session) return null;
    if (new Date() > this.session.expiresAt) {
      this.cleanup();
      return null;
    }
    if (!this.session.mobilePaired) return null;
    return this.session;
  }

  initiatePairing(tunnelUrl: string, durationHours?: number): { pairingId: string; desktopHalf: HalfKey; expiresAt: Date } {
    // Invalidate any previous session
    if (this.session) {
      this.cleanup();
    }

    const hours = normalizeDuration(durationHours);
    const desktopHalf = generateHalfKey();
    const pairingId = uuidv4();
    const expiresAt = new Date(Date.now() + hours * 3600_000);

    this.session = {
      pairingId,
      sessionKey: null,
      desktopHalf: desktopHalf.raw,
      tunnelUrl,
      qrUrl: '', // Set by PairingService after computing the full QR URL
      expiresAt,
      durationHours: hours,
      createdAt: new Date(),
      mobilePaired: false,
      mobileSessionId: '',
      screenShareGranted: false,
      lastToolRequest: null,
    };

    return { pairingId, desktopHalf, expiresAt };
  }

  completePairing(pairingId: string, mobileHalfEncoded: string): { mobileSessionId: string } {
    if (!this.session) {
      throw new Error('No active pairing session');
    }
    if (this.session.pairingId !== pairingId) {
      throw new Error('Pairing ID mismatch');
    }
    if (this.session.mobilePaired) {
      throw new Error('A mobile device is already paired');
    }
    if (new Date() > this.session.expiresAt) {
      this.cleanup();
      throw new Error('Pairing session expired');
    }

    const mobileHalf = decodeHalfKey(mobileHalfEncoded);
    this.session.sessionKey = deriveSessionKey(this.session.desktopHalf, mobileHalf);
    this.session.mobilePaired = true;
    this.session.mobileSessionId = `mobile-${pairingId}-${uuidv4()}`;

    return { mobileSessionId: this.session.mobileSessionId };
  }

  revoke(): void {
    this.cleanup();
  }

  setScreenShareGranted(granted: boolean): void {
    if (this.session && this.session.mobilePaired) {
      this.session.screenShareGranted = granted;
    }
  }

  isScreenShareGranted(): boolean {
    return this.session?.screenShareGranted ?? false;
  }

  updateLastToolRequest(info: ToolRequestInfo): void {
    if (this.session) {
      this.session.lastToolRequest = info;
    }
  }

  getSessionKeyForPairing(pairingId: string): Buffer | null {
    const s = this.getActiveSession();
    if (!s || s.pairingId !== pairingId) return null;
    return s.sessionKey;
  }

  private checkExpiration(): void {
    if (!this.session) return;
    if (new Date() > this.session.expiresAt) {
      console.log(`[SessionService] Session ${this.session.pairingId} expired, cleaning up`);
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.session) {
      // Wipe key material
      if (this.session.sessionKey) {
        this.session.sessionKey.fill(0);
      }
      this.session.desktopHalf.fill(0);
      this.session = null;
    }
    if (this.onSessionExpired) {
      this.onSessionExpired();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.session) {
      if (this.session.sessionKey) this.session.sessionKey.fill(0);
      this.session.desktopHalf.fill(0);
      this.session = null;
    }
  }
}

function normalizeDuration(hours?: number): number {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return DEFAULT_DURATION_HOURS;
  return Math.min(24, Math.max(1, Math.floor(hours)));
}
