export interface EncryptedPayload {
  /** Base64-encoded 12-byte initialization vector */
  iv: string;
  /** Base64-encoded ciphertext */
  ct: string;
  /** Base64-encoded 16-byte authentication tag */
  tag: string;
  /** Pairing ID for session lookup */
  pid: string;
}

export interface HalfKey {
  /** Raw 32-byte key material */
  raw: Buffer;
  /** Base64url-encoded for transport (QR / HTTP) */
  encoded: string;
}
