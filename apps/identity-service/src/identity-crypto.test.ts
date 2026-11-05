import { describe, expect, it } from 'vitest';
import { hashPassword, passwordPolicy, verifyPassword } from './identity-crypto.js';

describe('password policy', () => {
  it.each([8, 128])('accepts %i Unicode code points', length => {
    for (const character of ['a', '😀']) expect(() => passwordPolicy(character.repeat(length))).not.toThrow();
  });
  it.each([0, 7, 129])('rejects %i Unicode code points', length => {
    for (const character of ['a', '😀']) expect(() => passwordPolicy(character.repeat(length))).toThrow('PASSWORD_POLICY');
  });
  it.each([undefined, null, 12345678, {}, []])('rejects non-string input: %j', value => {
    expect(() => passwordPolicy(value)).toThrow('PASSWORD_POLICY');
  });
  it('preserves exact passwords and existing long credentials with Argon2id', async () => {
    for (const password of ['Wolfari1', ' an existing longer password ']) {
      const hash = await hashPassword(password);
      expect(hash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(hash, password)).toBe(true);
      expect(await verifyPassword(hash, password + 'x')).toBe(false);
      if (password.startsWith(' ')) expect(await verifyPassword(hash, password.trim())).toBe(false);
    }
  });
});
