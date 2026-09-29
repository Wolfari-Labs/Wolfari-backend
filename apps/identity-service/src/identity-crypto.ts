import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import * as argon2 from 'argon2';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

export function passwordPolicy(password: unknown): asserts password is string {
  if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128) {
    throw new Error('PASSWORD_POLICY');
  }
}

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);

export class IdentityCrypto {
  private readonly privateKey;
  private readonly publicKey;
  private readonly tokenKey;
  constructor(values: Record<string, string | undefined>) {
    if (!values.IDENTITY_ACCESS_PRIVATE_KEY || !values.IDENTITY_ACCESS_PUBLIC_KEY || !values.IDENTITY_TOKEN_KEY) throw new Error('IDENTITY_SECRET_MISSING');
    this.privateKey = createPrivateKey({ key: Buffer.from(values.IDENTITY_ACCESS_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey({ key: Buffer.from(values.IDENTITY_ACCESS_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
    this.tokenKey = Buffer.from(values.IDENTITY_TOKEN_KEY, 'hex');
    if (this.tokenKey.length !== 32) throw new Error('IDENTITY_TOKEN_KEY_INVALID');
  }

  access(userId: string, familyId: string, role: string): string {
    const now = Math.floor(Date.now() / 1000);
    const head = encode({ alg: 'RS256', typ: 'JWT' });
    const body = encode({ iss: 'wolfari.identity', aud: 'wolfari.api', sub: userId, sid: familyId, role, jti: randomUUID(), iat: now, exp: now + 900 });
    const data = `${head}.${body}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), this.privateKey).toString('base64url')}`;
  }

  verifyAccess(token: string): { userId: string; familyId: string; expiresAt: Date } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const head = decode(parts[0]!);
      const body = decode(parts[1]!);
      if (head.alg !== 'RS256' || head.typ !== 'JWT' || body.iss !== 'wolfari.identity' || body.aud !== 'wolfari.api') return null;
      if (typeof body.sub !== 'string' || typeof body.sid !== 'string' || typeof body.exp !== 'number' || body.exp <= Date.now() / 1000) return null;
      if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), this.publicKey, Buffer.from(parts[2]!, 'base64url'))) return null;
      return { userId: body.sub, familyId: body.sid, expiresAt: new Date(body.exp * 1000) };
    } catch { return null; }
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.tokenKey, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  }

  decrypt(value: string): string {
    const [iv, tag, data] = value.split('.');
    if (!iv || !tag || !data) throw new Error('INVALID_CIPHERTEXT');
    const cipher = createDecipheriv('aes-256-gcm', this.tokenKey, Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
  }
}
