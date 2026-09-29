import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import { currentCorrelationId } from '@wolfari/common';
import { parseEventForPublish } from '@wolfari/contracts/events';
import type { PoolClient } from 'pg';
import { IdentityCrypto, digest, hashPassword, newSecret, passwordPolicy, verifyPassword } from './identity-crypto';

type User = { id: string; email: string; full_name: string; avatar_object_key: string | null; system_role: string; status: string; email_verified_at: Date | null; version: number; password_hash?: string };
type Session = { id: string; user_id: string; family_id: string; token_hash: string; expires_at: Date; revoked_at: Date | null; replaced_by_session_id: string | null };
type OneTime = { id: string; user_id: string; purpose: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null; delivery_token_ciphertext: string | null };

export class IdentityError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly publicMessage = 'Request could not be completed') { super(code); }
}

const fail = (code: string, status: number, message?: string): never => { throw new IdentityError(code, status, message); };
const normalizeEmail = (input: unknown): string => {
  if (typeof input !== 'string') return fail('VALIDATION_FAILED', 400);
  const email = input.trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('VALIDATION_FAILED', 400);
  return email;
};
const validName = (input: unknown): string => {
  if (typeof input !== 'string') return fail('VALIDATION_FAILED', 400);
  const name = input.trim();
  if (!name || name.length > 150) return fail('VALIDATION_FAILED', 400);
  return name;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdentityService {
  readonly crypto: IdentityCrypto;
  private readonly linkBase: string;
  constructor(private readonly db: DatabaseProvider, config: ConfigService) {
    this.crypto = new IdentityCrypto({
      IDENTITY_ACCESS_PRIVATE_KEY: config.get('IDENTITY_ACCESS_PRIVATE_KEY'),
      IDENTITY_ACCESS_PUBLIC_KEY: config.get('IDENTITY_ACCESS_PUBLIC_KEY'),
      IDENTITY_TOKEN_KEY: config.get('IDENTITY_TOKEN_KEY'),
    });
    this.linkBase = config.getOrThrow<string>('IDENTITY_LINK_BASE_URL').replace(/\/$/, '');
  }

  private projection(user: User) {
    return { id: user.id, email: user.email, full_name: user.full_name, avatar: user.avatar_object_key ? '/api/v1/me/avatar' : null, system_role: user.system_role, status: user.status, email_verified_at: user.email_verified_at?.toISOString() ?? null, version: user.version };
  }

  private async userById(userId: string): Promise<User> {
    const { rows } = await this.db.query<User>('SELECT id,email,full_name,avatar_object_key,system_role,status,email_verified_at,version FROM users WHERE id=$1', [userId]);
    if (!rows[0]) return fail('UNAUTHENTICATED', 401);
    return rows[0];
  }

  private async issueEmail(client: PoolClient, user: User, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD', actorId: string | null): Promise<void> {
    const token = newSecret();
    const tokenId = randomUUID();
    const expires = new Date(Date.now() + (purpose === 'VERIFY_EMAIL' ? 24 * 3600_000 : 30 * 60_000));
    await client.query('UPDATE one_time_tokens SET revoked_at=now(), delivery_token_ciphertext=NULL WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL AND revoked_at IS NULL', [user.id, purpose]);
    await client.query('INSERT INTO one_time_tokens(id,user_id,purpose,token_hash,expires_at,delivery_token_ciphertext,delivery_token_expires_at) VALUES($1,$2,$3,$4,$5,$6,$5)', [tokenId, user.id, purpose, digest(token), expires, this.crypto.encrypt(token)]);
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const envelope = parseEventForPublish({
      event_id: eventId, event_type: 'AccountEmailRequested', schema_version: 1, occurred_at: occurredAt,
      producer: 'Identity', aggregate_type: 'User', aggregate_id: user.id, aggregate_version: user.version,
      correlation_id: currentCorrelationId() ?? randomUUID(), causation_id: null, operation_id: null, trip_id: null,
      actor_user_id: actorId, system_actor: actorId ? null : 'Identity',
      payload: { user_id: user.id, token_id: tokenId, purpose },
    });
    await client.query(`INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,occurred_at,actor_user_id,system_actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [eventId, envelope.event_type, 1, user.id, user.version, envelope.correlation_id, JSON.stringify(envelope.payload), 'User', 'Identity', occurredAt, actorId, actorId ? null : 'Identity']);
  }

  async register(input: Record<string, unknown>): Promise<void> {
    const email = normalizeEmail(input.email);
    const name = validName(input.full_name);
    passwordPolicy(input.password);
    const passwordHash = await hashPassword(input.password);
    try {
      await this.db.withTransaction(async client => {
        const { rows } = await client.query<User>('INSERT INTO users(email,full_name) VALUES($1,$2) RETURNING id,email,full_name,avatar_object_key,system_role,status,email_verified_at,version', [email, name]);
        const user = rows[0]!;
        await client.query('INSERT INTO credentials(user_id,password_hash,password_changed_at) VALUES($1,$2,now())', [user.id, passwordHash]);
        await this.issueEmail(client, user, 'VERIFY_EMAIL', null);
      });
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }

  async login(input: Record<string, unknown>) {
    const email = normalizeEmail(input.email);
    if (typeof input.password !== 'string') return fail('UNAUTHENTICATED', 401);
    const { rows } = await this.db.query<User>('SELECT u.*,c.password_hash FROM users u JOIN credentials c ON c.user_id=u.id WHERE lower(u.email)=$1', [email]);
    const user = rows[0];
    if (!user || !(await verifyPassword(user.password_hash!, input.password)) || user.status !== 'ACTIVE') return fail('UNAUTHENTICATED', 401);
    const familyId = randomUUID();
    const refresh = newSecret();
    const expires = new Date(Date.now() + 30 * 24 * 3600_000);
    await this.db.withTransaction(async client => {
      const locked = await client.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const credential = await client.query<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id=$1', [user.id]);
      if (locked.rows[0]?.status !== 'ACTIVE' || credential.rows[0]?.password_hash !== user.password_hash) return fail('UNAUTHENTICATED', 401);
      await client.query('INSERT INTO refresh_sessions(user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [user.id, familyId, digest(refresh), expires]);
    });
    return { access_token: this.crypto.access(user.id, familyId, user.system_role), refresh_token: refresh, token_type: 'Bearer', expires_in: 900, profile: this.projection(user) };
  }

  async refresh(raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 200) return fail('UNAUTHENTICATED', 401);
    const first = await this.db.query<Session>('SELECT * FROM refresh_sessions WHERE token_hash=$1', [digest(raw)]);
    const prior = first.rows[0];
    if (!prior) return fail('UNAUTHENTICATED', 401);
    const fresh = newSecret();
    const outcome = await this.db.withTransaction(async client => {
      const user = (await client.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [prior.user_id])).rows[0];
      const current = (await client.query<Session>('SELECT * FROM refresh_sessions WHERE id=$1 FOR UPDATE', [prior.id])).rows[0];
      if (!user || !current) return null;
      if (current.replaced_by_session_id) {
        await client.query('UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1', [current.family_id]);
        return null;
      }
      if (current.revoked_at || current.expires_at <= new Date() || user.status !== 'ACTIVE') return null;
      const replacement = randomUUID();
      await client.query('INSERT INTO refresh_sessions(id,user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)', [replacement, user.id, current.family_id, digest(fresh), current.expires_at]);
      await client.query('UPDATE refresh_sessions SET replaced_by_session_id=$2,revoked_at=now(),last_used_at=now() WHERE id=$1', [current.id, replacement]);
      return user;
    });
    if (!outcome) return fail('UNAUTHENTICATED', 401);
    return { access_token: this.crypto.access(outcome.id, prior.family_id, outcome.system_role), refresh_token: fresh, token_type: 'Bearer', expires_in: 900, profile: this.projection(outcome) };
  }

  async validateAccess(raw: unknown): Promise<{ user: User; familyId: string; expiresAt: Date }> {
    if (typeof raw !== 'string') return fail('UNAUTHENTICATED', 401);
    const claim = this.crypto.verifyAccess(raw);
    if (!claim) return fail('UNAUTHENTICATED', 401);
    const user = await this.userById(claim.userId);
    if (user.status !== 'ACTIVE') return fail('UNAUTHENTICATED', 401);
    const { rows } = await this.db.query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM refresh_sessions WHERE user_id=$1 AND family_id=$2 AND revoked_at IS NULL AND replaced_by_session_id IS NULL AND expires_at>now()) AS ok`, [user.id, claim.familyId]);
    if (!rows[0]?.ok) return fail('UNAUTHENTICATED', 401);
    return { user, familyId: claim.familyId, expiresAt: claim.expiresAt };
  }

  async profile(userId: string) { return this.projection(await this.userById(userId)); }

  async updateProfile(userId: string, input: Record<string, unknown>) {
    if (!Number.isInteger(input.expected_version) || Number(input.expected_version) < 1) return fail('VALIDATION_FAILED', 400);
    const fields: string[] = [];
    const values: unknown[] = [];
    if ('full_name' in input) { fields.push(`full_name=$${values.length + 1}`); values.push(validName(input.full_name)); }
    if ('avatar_object_key' in input) {
      if (input.avatar_object_key !== null && (typeof input.avatar_object_key !== 'string' || !input.avatar_object_key.startsWith(`users/${userId}/avatars/`))) return fail('VALIDATION_FAILED', 400);
      fields.push(`avatar_object_key=$${values.length + 1}`); values.push(input.avatar_object_key);
    }
    if (!fields.length) return fail('VALIDATION_FAILED', 400);
    values.push(userId, input.expected_version);
    const { rows } = await this.db.query<User>(`UPDATE users SET ${fields.join(',')},version=version+1,updated_at=now() WHERE id=$${values.length - 1} AND version=$${values.length} RETURNING *`, values);
    if (!rows[0]) return fail('VERSION_CONFLICT', 409);
    return this.projection(rows[0]);
  }

  async emailVerification(userId: string) {
    await this.db.withTransaction(async client => {
      const user = (await client.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!user || user.status !== 'ACTIVE') return fail('UNAUTHENTICATED', 401);
      if (!user.email_verified_at) await this.issueEmail(client, user, 'VERIFY_EMAIL', userId);
    });
  }

  async resetRequest(emailInput: unknown) {
    const email = normalizeEmail(emailInput);
    await this.db.withTransaction(async client => {
      const user = (await client.query<User>('SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE', [email])).rows[0];
      if (user?.status === 'ACTIVE') await this.issueEmail(client, user, 'RESET_PASSWORD', null);
    });
  }

  private async consumeToken(raw: unknown, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD', newPassword?: string) {
    if (typeof raw !== 'string' || raw.length > 200) return fail('VALIDATION_FAILED', 400);
    const found = (await this.db.query<OneTime>('SELECT * FROM one_time_tokens WHERE token_hash=$1 AND purpose=$2', [digest(raw), purpose])).rows[0];
    if (!found) return fail('VALIDATION_FAILED', 400);
    const newHash = newPassword === undefined ? null : await hashPassword(newPassword);
    await this.db.withTransaction(async client => {
      const user = (await client.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [found.user_id])).rows[0];
      const token = (await client.query<OneTime>('SELECT * FROM one_time_tokens WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
      if (!user || !token || token.used_at || token.revoked_at || token.expires_at <= new Date() || user.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 400);
      await client.query('UPDATE one_time_tokens SET used_at=now(),delivery_token_ciphertext=NULL WHERE id=$1', [token.id]);
      if (purpose === 'VERIFY_EMAIL') await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),version=version+1,updated_at=now() WHERE id=$1', [user.id]);
      else {
        await client.query('UPDATE credentials SET password_hash=$2,password_changed_at=now(),updated_at=now() WHERE user_id=$1', [user.id, newHash]);
        await client.query('UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [user.id]);
        await client.query("UPDATE one_time_tokens SET revoked_at=COALESCE(revoked_at,now()),delivery_token_ciphertext=NULL WHERE user_id=$1 AND purpose='RESET_PASSWORD' AND id<>$2 AND used_at IS NULL", [user.id, token.id]);
      }
    });
  }

  confirmEmail(raw: unknown) { return this.consumeToken(raw, 'VERIFY_EMAIL'); }
  resetPassword(raw: unknown, password: unknown) { passwordPolicy(password); return this.consumeToken(raw, 'RESET_PASSWORD', password); }

  async changePassword(userId: string, current: unknown, next: unknown) {
    passwordPolicy(next);
    if (typeof current !== 'string') return fail('UNAUTHENTICATED', 401);
    const existing = (await this.db.query<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id=$1', [userId])).rows[0];
    if (!existing || !(await verifyPassword(existing.password_hash, current))) return fail('UNAUTHENTICATED', 401);
    const nextHash = await hashPassword(next);
    await this.db.withTransaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const credential = (await client.query<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
      if (credential?.password_hash !== existing.password_hash) return fail('UNAUTHENTICATED', 401);
      await client.query('UPDATE credentials SET password_hash=$2,password_changed_at=now(),updated_at=now() WHERE user_id=$1', [userId, nextHash]);
      await client.query('UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [userId]);
      await client.query("UPDATE one_time_tokens SET revoked_at=COALESCE(revoked_at,now()),delivery_token_ciphertext=NULL WHERE user_id=$1 AND purpose='RESET_PASSWORD' AND used_at IS NULL", [userId]);
    });
  }

  async sessions(userId: string, limit: number, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('VALIDATION_FAILED', 400);
    let olderAt: string | null = null; let olderId: string | null = null;
    if (cursor) {
      try { [olderAt, olderId] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string]; }
      catch { return fail('VALIDATION_FAILED', 400); }
      if (!olderAt || !olderId || !uuid.test(olderId) || Number.isNaN(Date.parse(olderAt))) return fail('VALIDATION_FAILED', 400);
    }
    const { rows } = await this.db.query<{ id: string; created_at: Date; last_used_at: Date | null; expires_at: Date; revoked_at: Date | null }>(`SELECT id,created_at,last_used_at,expires_at,revoked_at FROM refresh_sessions WHERE user_id=$1 AND replaced_by_session_id IS NULL AND revoked_at IS NULL AND expires_at>now() AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`, [userId, olderAt, olderId, limit + 1]);
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return { items: shown, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.created_at.toISOString(), last.id])).toString('base64url') : null };
  }

  async revokeSession(userId: string, sessionId: unknown) {
    if (typeof sessionId !== 'string' || !uuid.test(sessionId)) return fail('VALIDATION_FAILED', 400);
    await this.db.withTransaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const row = (await client.query<{ family_id: string }>('SELECT family_id FROM refresh_sessions WHERE user_id=$1 AND id=$2', [userId, sessionId])).rows[0];
      if (!row) return fail('RESOURCE_NOT_FOUND', 404);
      await client.query('UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1 AND user_id=$2', [row.family_id, userId]);
    });
  }

  async profiles(userIds: unknown) {
    if (!Array.isArray(userIds) || userIds.length > 100 || userIds.some(id => typeof id !== 'string' || !uuid.test(id))) return fail('VALIDATION_FAILED', 400);
    const { rows } = await this.db.query<User>('SELECT id,full_name FROM users WHERE id=ANY($1::uuid[]) AND status<>\'ANONYMIZED\'', [userIds]);
    return { profiles: rows.map(user => ({ id: user.id, display_name: user.full_name })) };
  }

  async emailDelivery(tokenId: unknown) {
    if (typeof tokenId !== 'string' || !uuid.test(tokenId)) return { valid: false };
    const { rows } = await this.db.query<OneTime & { recipient_email: string; status: string }>('SELECT t.*,u.email AS recipient_email,u.status FROM one_time_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [tokenId]);
    const token = rows[0];
    if (token && token.expires_at <= new Date() && token.delivery_token_ciphertext) {
      await this.db.query('UPDATE one_time_tokens SET delivery_token_ciphertext=NULL WHERE id=$1 AND expires_at<=now()', [token.id]);
    }
    if (!token || token.status !== 'ACTIVE' || token.used_at || token.revoked_at || token.expires_at <= new Date() || !token.delivery_token_ciphertext) return { valid: false };
    const raw = this.crypto.decrypt(token.delivery_token_ciphertext);
    const route = token.purpose === 'VERIFY_EMAIL' ? 'verify' : 'reset';
    return { valid: true, delivery: { user_id: token.user_id, recipient_email: token.recipient_email, purpose: token.purpose === 'VERIFY_EMAIL' ? 1 : 2, one_time_link: `${this.linkBase}/api/v1/auth/local/${route}?token=${encodeURIComponent(raw)}`, expires_at: { seconds: String(Math.floor(token.expires_at.getTime() / 1000)), nanos: 0 } } };
  }

  async cleanupExpiredTokens() {
    await this.db.query('UPDATE one_time_tokens SET delivery_token_ciphertext=NULL WHERE expires_at<=now() AND delivery_token_ciphertext IS NOT NULL');
  }
}
