import { randomBytes } from 'node:crypto';
import { decryptDocument, encryptDocument } from './document-crypto';

describe('IRD password encryption', () => {
  const key = randomBytes(32);
  it('preserves exact characters and uses a fresh nonce', () => {
    const password = '  =IRD-"पासवर्ड"-001  ';
    const first = encryptDocument(password, key, 'client:one');
    expect(first).not.toContain(password);
    expect(encryptDocument(password, key, 'client:one')).not.toBe(first);
    expect(decryptDocument(first, key, 'client:one')).toBe(password);
  });
  it('rejects ciphertext moved to another client, altered ciphertext, or a different key', () => {
    const cipher = encryptDocument('secret', key, 'client:one');
    expect(() => decryptDocument(cipher, key, 'client:two')).toThrow();
    expect(() =>
      decryptDocument(cipher, randomBytes(32), 'client:one'),
    ).toThrow();
    const bytes = Buffer.from(cipher, 'base64url');
    bytes[bytes.length - 1] ^= 1;
    expect(() =>
      decryptDocument(bytes.toString('base64url'), key, 'client:one'),
    ).toThrow();
  });
});
