import type { PairingParams, PairingState } from './types';
import {
  generateMobileHalfKey,
  deriveSessionKey,
  base64urlToArrayBuffer,
  exportSessionKey,
  importSessionKey,
  storeSessionKey,
  loadStoredSessionKey,
  clearStoredSessionKey,
} from './crypto';

const SESSION_STATE_KEY = 'oasis-pairing-state';

/**
 * Parse pairing parameters from a URL hash fragment.
 * Format: #pair/<pairingId>/<base64url_desktop_half>/<expires_epoch>
 */
export function parsePairingParams(hash: string): PairingParams | null {
  const match = hash.match(/^#pair\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) return null;

  return {
    pairingId: match[1],
    desktopHalfKey: match[2],
    expiresEpoch: parseInt(match[3], 10),
    tunnelUrl: window.location.origin,
  };
}

/**
 * Complete the pairing handshake: generate mobile half-key, derive session key,
 * and call the relay's /pair/complete endpoint.
 */
export async function completePairing(
  params: PairingParams,
): Promise<PairingState> {
  // Check if pairing has expired
  if (Date.now() / 1000 > params.expiresEpoch) {
    throw new Error('QR code has expired. Request a new one on the desktop.');
  }

  // Generate mobile half-key
  const mobileHalf = generateMobileHalfKey();

  // Derive session key from both halves
  const desktopHalf = base64urlToArrayBuffer(params.desktopHalfKey);
  const sessionKey = await deriveSessionKey(desktopHalf, mobileHalf.raw);

  // Complete pairing with the relay
  const res = await fetch(`${params.tunnelUrl}/pair/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairing_id: params.pairingId,
      mobile_half_key: mobileHalf.encoded,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || `Pairing failed (${res.status})`);
  }

  const data = await res.json();

  const state: PairingState = {
    paired: true,
    tunnelUrl: params.tunnelUrl,
    sessionKey,
    pairingId: params.pairingId,
    mobileSessionId: data.mobile_session_id,
    expiresAt: new Date(data.expires_at),
  };

  // Persist so session survives page refreshes
  await persistPairingState(state);

  return state;
}

export function createIdlePairingState(): PairingState {
  return {
    paired: false,
    tunnelUrl: null,
    sessionKey: null,
    pairingId: null,
    mobileSessionId: null,
    expiresAt: null,
  };
}

/**
 * Save pairing state to sessionStorage so it survives page refreshes.
 */
async function persistPairingState(state: PairingState): Promise<void> {
  if (!state.paired || !state.sessionKey) return;
  const keyBase64 = await exportSessionKey(state.sessionKey);
  storeSessionKey(keyBase64);
  sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify({
    tunnelUrl: state.tunnelUrl,
    pairingId: state.pairingId,
    mobileSessionId: state.mobileSessionId,
    expiresAt: state.expiresAt?.toISOString(),
  }));
}

/**
 * Restore pairing state from sessionStorage (e.g. after page refresh).
 */
export async function restorePairingState(): Promise<PairingState | null> {
  const keyBase64 = loadStoredSessionKey();
  const stateJson = sessionStorage.getItem(SESSION_STATE_KEY);
  if (!keyBase64 || !stateJson) return null;

  try {
    const saved = JSON.parse(stateJson);
    const expiresAt = new Date(saved.expiresAt);
    // Check if expired
    if (new Date() > expiresAt) {
      clearPairingState();
      return null;
    }
    const sessionKey = await importSessionKey(keyBase64);
    return {
      paired: true,
      tunnelUrl: saved.tunnelUrl,
      sessionKey,
      pairingId: saved.pairingId,
      mobileSessionId: saved.mobileSessionId,
      expiresAt,
    };
  } catch {
    clearPairingState();
    return null;
  }
}

/**
 * Clear persisted pairing state.
 */
export function clearPairingState(): void {
  clearStoredSessionKey();
  sessionStorage.removeItem(SESSION_STATE_KEY);
}
