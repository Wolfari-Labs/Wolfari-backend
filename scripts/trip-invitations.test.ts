import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { RPC_CATALOG } from '../packages/contracts/src/grpc';
import {
  InvitationCrypto,
  invitationEmail,
  invitationTokenHash,
} from '../apps/trip-workspace-service/src/invitation-crypto';

describe('invitation secrets and contract boundaries', () => {
  it('mints independent 256-bit namespaced tokens and deterministic digests', () => {
    const crypto = new InvitationCrypto(randomBytes(32).toString('hex'));
    const first = crypto.mint(),
      second = crypto.mint();
    expect(first).toMatch(/^inv1_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(invitationTokenHash(first)).toHaveLength(64);
    expect(invitationTokenHash(first)).toBe(invitationTokenHash(first));
    expect(invitationTokenHash(first)).not.toBe(invitationTokenHash(second));
  });
  it.each(['', 'inv1_short', 'x'.repeat(43), `inv1_${'a'.repeat(42)}!`, null, 3])(
    'rejects malformed token %s',
    (value) => {
      expect(() => invitationTokenHash(value)).toThrow('VALIDATION_FAILED');
    },
  );
  it('authenticates encrypted tokens with an independent key and random IV', () => {
    const crypto = new InvitationCrypto(randomBytes(32).toString('hex'));
    const token = crypto.mint(),
      encrypted = crypto.encrypt(token);
    expect(encrypted).not.toContain(token);
    expect(crypto.decrypt(encrypted)).toBe(token);
    expect(crypto.encrypt(token)).not.toBe(encrypted);
    expect(() =>
      new InvitationCrypto(randomBytes(32).toString('hex')).decrypt(encrypted),
    ).toThrow();
    const parts = encrypted.split('.');
    parts[1] = Buffer.alloc(16).toString('base64url');
    expect(() => crypto.decrypt(parts.join('.'))).toThrow();
    expect(() => new InvitationCrypto('weak')).toThrow();
  });
  it('normalizes email exactly once and rejects invalid shapes', () => {
    expect(invitationEmail('  Ha@Example.Test  ')).toBe('ha@example.test');
    for (const value of ['bad', 'a b@example.test', undefined, 'a'.repeat(250) + '@example.test'])
      expect(() => invitationEmail(value)).toThrow('VALIDATION_FAILED');
  });
  it('freezes the nine new capability boundaries and 2-second deadlines', () => {
    const names = [
      'CreateInvitation',
      'ListInvitations',
      'PreviewInvitation',
      'AcceptInvitation',
      'DeclineInvitation',
      'RevokeInvitation',
      'ResendInvitation',
    ];
    for (const name of names)
      expect(RPC_CATALOG.find((entry) => entry.method === name)).toMatchObject({
        callers: ['ApiGateway'],
        deadline_ms: 2000,
      });
    expect(RPC_CATALOG.find((entry) => entry.method === 'GetInvitationIdentity')).toMatchObject({
      callers: ['Trip'],
      deadline_ms: 2000,
    });
    expect(
      RPC_CATALOG.find((entry) => entry.method === 'AcknowledgeInvitationDelivery'),
    ).toMatchObject({ callers: ['Automation'], deadline_ms: 2000 });
  });
});
