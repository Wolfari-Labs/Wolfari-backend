import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from './trip.errors';

export function invitationTokenHash(token: unknown): string {
  if (typeof token !== 'string' || !/^inv1_[A-Za-z0-9_-]{43}$/.test(token))
    return fail('VALIDATION_FAILED', 400);
  return createHash('sha256').update(`wolfari:invitation:v1:${token}`).digest('hex');
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
