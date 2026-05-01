import { describe, it, expect } from 'vitest';
import { encryptValue, decryptValue } from '@/common/helpers/crypto-helpers';

describe('crypto-helpers', () => {
  const secret = 'test-jwt-secret-that-is-long-enough';

  describe('encryptValue / decryptValue', () => {
    it('should round-trip a plaintext string', () => {
      const plaintext = 'sk-ant-api03-test-key-12345';
      const encrypted = encryptValue(plaintext, secret);
      const decrypted = decryptValue(encrypted, secret);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for the same plaintext (random IV)', () => {
      const plaintext = 'my-api-key';
      const a = encryptValue(plaintext, secret);
      const b = encryptValue(plaintext, secret);
      expect(a).not.toBe(b);
      expect(decryptValue(a, secret)).toBe(plaintext);
      expect(decryptValue(b, secret)).toBe(plaintext);
    });

    it('should fail decryption with a wrong secret', () => {
      const encrypted = encryptValue('hello', secret);
      expect(() => decryptValue(encrypted, 'wrong-secret')).toThrow();
    });

    it('should fail decryption with tampered ciphertext', () => {
      const encrypted = encryptValue('hello', secret);
      const buf = Buffer.from(encrypted, 'base64');
      buf[buf.length - 5] ^= 0xff; // flip a byte
      const tampered = buf.toString('base64');
      expect(() => decryptValue(tampered, secret)).toThrow();
    });

    it('should handle empty string', () => {
      const encrypted = encryptValue('', secret);
      expect(decryptValue(encrypted, secret)).toBe('');
    });

    it('should handle unicode content', () => {
      const plaintext = '日本語テスト 🔑';
      const encrypted = encryptValue(plaintext, secret);
      expect(decryptValue(encrypted, secret)).toBe(plaintext);
    });

    it('should produce base64-encoded output', () => {
      const encrypted = encryptValue('test', secret);
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
      // Re-encoding should produce the same string (valid base64)
      const buf = Buffer.from(encrypted, 'base64');
      expect(buf.toString('base64')).toBe(encrypted);
    });
  });
});
