import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  emailCodeHash,
  emailCodeMatches,
  newEmailCode,
  openDelivery,
  sealDelivery,
} from './identity-crypto';
import { IdentityController, oneOf } from './identity.controller';
import type { IdentityService } from './identity.service';
import type { AvatarService } from './avatar.service';

describe('email codes', () => {
  it('are six zero-padded digits', () => {
    for (let i = 0; i < 200; i++) expect(newEmailCode()).toMatch(/^[0-9]{6}$/);
  });
  it('only match the same purpose, user and code', () => {
    const stored = emailCodeHash('VERIFY_EMAIL', 'user-1', '012345');
    expect(emailCodeMatches(stored, 'VERIFY_EMAIL', 'user-1', '012345')).toBe(true);
    expect(emailCodeMatches(stored, 'RESET_PASSWORD', 'user-1', '012345')).toBe(false);
    expect(emailCodeMatches(stored, 'VERIFY_EMAIL', 'user-2', '012345')).toBe(false);
    expect(emailCodeMatches(stored, 'VERIFY_EMAIL', 'user-1', '012346')).toBe(false);
  });
  it('round-trips the delivery payload and reads pre-code rows as token only', () => {
    expect(openDelivery(sealDelivery('tok_en-1', '007007'))).toEqual({
      token: 'tok_en-1',
      code: '007007',
    });
    expect(openDelivery('tok_en-1')).toEqual({ token: 'tok_en-1' });
  });
});

describe('confirmation body shapes', () => {
  it('accepts exactly a link token or email + code', () => {
    const shapes = [['token'], ['email', 'code']];
    expect(oneOf({ token: 't' }, shapes)).toEqual({ token: 't' });
    expect(oneOf({ code: '1', email: 'a@b.c' }, shapes)).toEqual({ code: '1', email: 'a@b.c' });
    for (const body of [
      {},
      { email: 'a@b.c' },
      { token: 't', code: '1' },
      { token: 't', extra: 1 },
      null,
      [],
    ])
      expect(() => oneOf(body, shapes)).toThrow();
  });
  it('routes both verify and reset shapes to the service', async () => {
    const confirmEmail = vi.fn(),
      resetPassword = vi.fn();
    const controller = new IdentityController(
      { confirmEmail, resetPassword } as unknown as IdentityService,
      {} as AvatarService,
    );
    await controller.verify({ email: 'a@b.c', code: '123456' });
    await controller.reset({ email: 'a@b.c', code: '123456', new_password: 'Wolfari1' });
    await controller.reset({ token: 't', new_password: 'Wolfari1' });
    expect(confirmEmail).toHaveBeenCalledWith({ email: 'a@b.c', code: '123456' });
    expect(resetPassword).toHaveBeenCalledTimes(2);
    await expect(controller.reset({ email: 'a@b.c', code: '123456' })).rejects.toThrow();
  });
});
