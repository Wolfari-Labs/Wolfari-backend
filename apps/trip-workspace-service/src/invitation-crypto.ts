import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from './trip.errors';

export function invitationTokenHash(token: unknown): string {
  if (typeof token !== 'string' || !/^inv1_[A-Za-z0-9_-]{43}$/.test(token))
    return fail('VALIDATION_FAILED', 400);
  return createHash('sha256').update(`wolfari:invitation:v1:${token}`).digest('hex');
}

// Crockford base32 without I, L, O, U: easy to read aloud and type.
const JOIN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8 random characters (40 bits); shown as XXXX-XXXX. */
export function mintJoinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => JOIN_ALPHABET[byte & 31]).join('');
}

export function formatJoinCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Normalizes user input (case, spaces, dashes, confusable letters); undefined when not a join code. */
export function normalizeJoinCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32) return undefined;
  const code = value
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : undefined;
}

export function joinCodeHash(code: string): string {
  return createHash('sha256').update(`wolfari:invitation-code:v1:${code}`).digest('hex');
}

export function invitationEmail(value: unknown): string {
  if (typeof value !== 'string') return fail('VALIDATION_FAILED', 400);
  const email = value.trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return fail('VALIDATION_FAILED', 400);
  return email;
}

export class InvitationCrypto {
  private readonly key: Buffer;
  constructor(key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid invitation encryption key');
    this.key = Buffer.from(key, 'hex');
  }
  mint() {
    return `inv1_${randomBytes(32).toString('base64url')}`;
  }
  encrypt(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('wolfari:invitation:v1'));
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  }
  decrypt(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('Invalid invitation ciphertext');
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url')) as [
      Buffer,
      Buffer,
      Buffer,
    ];
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from('wolfari:invitation:v1'));
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    invitationTokenHash(token);
    return token;
  }
}
