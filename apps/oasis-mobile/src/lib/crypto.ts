import type { EncryptedPayload } from './types';

const ALGO = 'AES-GCM';
const IV_BYTES = 12;

/**
 * Generate a 32-byte random half-key for key exchange.
 */
export function generateMobileHalfKey(): { raw: ArrayBuffer; encoded: string } {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return {
    raw: raw.buffer,
    encoded: arrayBufferToBase64url(raw.buffer),
  };
}

/**
 * Derive a session key from desktop + mobile half-keys via SHA-256.
 */
export async function deriveSessionKey(
  desktopHalf: ArrayBuffer,
  mobileHalf: ArrayBuffer,
): Promise<CryptoKey> {
  const combined = new Uint8Array(desktopHalf.byteLength + mobileHalf.byteLength);
  combined.set(new Uint8Array(desktopHalf), 0);
  combined.set(new Uint8Array(mobileHalf), desktopHalf.byteLength);

  const hash = await crypto.subtle.digest('SHA-256', combined);
  return crypto.subtle.importKey('raw', hash, ALGO, true, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a plaintext string using the session key.
 */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
  pairingId: string,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);

  // WebCrypto appends the 16-byte tag to the ciphertext
  const fullCt = new Uint8Array(ciphertext);
  const ct = fullCt.slice(0, fullCt.length - 16);
  const tag = fullCt.slice(fullCt.length - 16);

  return {
    iv: arrayBufferToBase64(iv.buffer),
    ct: arrayBufferToBase64(ct.buffer),
    tag: arrayBufferToBase64(tag.buffer),
    pid: pairingId,
  };
}

/**
 * Decrypt an encrypted payload using the session key.
 */
export async function decrypt(
  payload: EncryptedPayload,
  key: CryptoKey,
): Promise<string> {
  const iv = base64ToArrayBuffer(payload.iv);
  const ct = base64ToArrayBuffer(payload.ct);
  const tag = base64ToArrayBuffer(payload.tag);

  // WebCrypto expects ciphertext + tag concatenated
  const combined = new Uint8Array(ct.byteLength + tag.byteLength);
  combined.set(new Uint8Array(ct), 0);
  combined.set(new Uint8Array(tag), ct.byteLength);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv: new Uint8Array(iv) },
    key,
    combined,
  );

  return new TextDecoder().decode(decrypted);
}

// ── Session key persistence ────────────────────────────────────────────────

const SESSION_KEY_STORAGE = 'oasis-session-key';

export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(raw);
}

export async function importSessionKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToArrayBuffer(base64);
  return crypto.subtle.importKey('raw', raw, ALGO, true, ['encrypt', 'decrypt']);
}

export function storeSessionKey(base64Key: string): void {
  sessionStorage.setItem(SESSION_KEY_STORAGE, base64Key);
}

export function loadStoredSessionKey(): string | null {
  return sessionStorage.getItem(SESSION_KEY_STORAGE);
}

export function clearStoredSessionKey(): void {
  sessionStorage.removeItem(SESSION_KEY_STORAGE);
}

// ── Base64 helpers ──────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  return arrayBufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToArrayBuffer(base64);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
