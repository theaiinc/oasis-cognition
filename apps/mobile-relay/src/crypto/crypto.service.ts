import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { EncryptedPayload, HalfKey } from './crypto.types';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HALF_KEY_BYTES = 32;

export function generateHalfKey(): HalfKey {
  const raw = randomBytes(HALF_KEY_BYTES);
  return {
    raw,
    encoded: raw.toString('base64url'),
  };
}

export function deriveSessionKey(desktopHalf: Buffer, mobileHalf: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([desktopHalf, mobileHalf]))
    .digest();
}

export function decodeHalfKey(encoded: string): Buffer {
  return Buffer.from(encoded, 'base64url');
}

export function encrypt(plaintext: string, sessionKey: Buffer, pairingId: string): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    ct: encrypted.toString('base64'),
    tag: tag.toString('base64'),
    pid: pairingId,
  };
}

export function decrypt(payload: EncryptedPayload, sessionKey: Buffer): string {
  const iv = Buffer.from(payload.iv, 'base64');
  const ct = Buffer.from(payload.ct, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid tag length');

  const decipher = createDecipheriv(ALGO, sessionKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decrypted.toString('utf8');
}
