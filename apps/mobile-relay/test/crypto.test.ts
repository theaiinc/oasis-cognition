import {
  generateHalfKey,
  deriveSessionKey,
  decodeHalfKey,
  encrypt,
  decrypt,
} from '../src/crypto/crypto.service';
import { EncryptedPayload } from '../src/crypto/crypto.types';

describe('Crypto Service', () => {
  describe('generateHalfKey', () => {
    it('generates a 32-byte key', () => {
      const key = generateHalfKey();
      expect(key.raw).toBeInstanceOf(Buffer);
      expect(key.raw.length).toBe(32);
      expect(key.encoded).toBeTruthy();
    });

    it('generates unique keys', () => {
      const a = generateHalfKey();
      const b = generateHalfKey();
      expect(a.encoded).not.toBe(b.encoded);
    });
  });

  describe('deriveSessionKey', () => {
    it('produces a 32-byte key from two halves', () => {
      const a = generateHalfKey();
      const b = generateHalfKey();
      const sessionKey = deriveSessionKey(a.raw, b.raw);
      expect(sessionKey).toBeInstanceOf(Buffer);
      expect(sessionKey.length).toBe(32);
    });

    it('produces the same key for the same inputs', () => {
      const a = generateHalfKey();
      const b = generateHalfKey();
      const k1 = deriveSessionKey(a.raw, b.raw);
      const k2 = deriveSessionKey(a.raw, b.raw);
      expect(k1.equals(k2)).toBe(true);
    });

    it('produces different keys for different inputs', () => {
      const a = generateHalfKey();
      const b = generateHalfKey();
      const c = generateHalfKey();
      const k1 = deriveSessionKey(a.raw, b.raw);
      const k2 = deriveSessionKey(a.raw, c.raw);
      expect(k1.equals(k2)).toBe(false);
    });
  });

  describe('decodeHalfKey', () => {
    it('round-trips through base64url encoding', () => {
      const key = generateHalfKey();
      const decoded = decodeHalfKey(key.encoded);
      expect(decoded.equals(key.raw)).toBe(true);
    });
  });

  describe('encrypt / decrypt', () => {
    const pairingId = 'test-pairing-123';
    let sessionKey: Buffer;

    beforeAll(() => {
      const a = generateHalfKey();
      const b = generateHalfKey();
      sessionKey = deriveSessionKey(a.raw, b.raw);
    });

    it('round-trips a simple string', () => {
      const plaintext = 'Hello, mobile!';
      const encrypted = encrypt(plaintext, sessionKey, pairingId);

      expect(encrypted.pid).toBe(pairingId);
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.ct).toBeTruthy();
      expect(encrypted.tag).toBeTruthy();

      const decrypted = decrypt(encrypted, sessionKey);
      expect(decrypted).toBe(plaintext);
    });

    it('round-trips a JSON payload', () => {
      const payload = JSON.stringify({
        user_message: 'What is the weather?',
        session_id: 'mobile-abc-123',
        context: { source: 'mobile-companion' },
      });
      const encrypted = encrypt(payload, sessionKey, pairingId);
      const decrypted = decrypt(encrypted, sessionKey);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(payload));
    });

    it('round-trips a large payload', () => {
      const large = 'x'.repeat(100_000);
      const encrypted = encrypt(large, sessionKey, pairingId);
      const decrypted = decrypt(encrypted, sessionKey);
      expect(decrypted).toBe(large);
    });

    it('round-trips unicode content', () => {
      const unicode = 'Xin chao! 🌏 Cafe sua da ☕ Pho 🍜';
      const encrypted = encrypt(unicode, sessionKey, pairingId);
      const decrypted = decrypt(encrypted, sessionKey);
      expect(decrypted).toBe(unicode);
    });

    it('produces different ciphertexts for the same plaintext (random IV)', () => {
      const plaintext = 'same input';
      const a = encrypt(plaintext, sessionKey, pairingId);
      const b = encrypt(plaintext, sessionKey, pairingId);
      expect(a.iv).not.toBe(b.iv);
      expect(a.ct).not.toBe(b.ct);
    });

    it('fails to decrypt with wrong key', () => {
      const plaintext = 'secret message';
      const encrypted = encrypt(plaintext, sessionKey, pairingId);

      const wrongKey = deriveSessionKey(generateHalfKey().raw, generateHalfKey().raw);
      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('fails to decrypt tampered ciphertext', () => {
      const encrypted = encrypt('test', sessionKey, pairingId);
      const tampered: EncryptedPayload = {
        ...encrypted,
        ct: Buffer.from('tampered data').toString('base64'),
      };
      expect(() => decrypt(tampered, sessionKey)).toThrow();
    });

    it('fails on invalid IV length', () => {
      const encrypted = encrypt('test', sessionKey, pairingId);
      const bad: EncryptedPayload = {
        ...encrypted,
        iv: Buffer.from('short').toString('base64'),
      };
      expect(() => decrypt(bad, sessionKey)).toThrow('Invalid IV length');
    });

    it('fails on invalid tag length', () => {
      const encrypted = encrypt('test', sessionKey, pairingId);
      const bad: EncryptedPayload = {
        ...encrypted,
        tag: Buffer.from('short').toString('base64'),
      };
      expect(() => decrypt(bad, sessionKey)).toThrow('Invalid tag length');
    });
  });
});
