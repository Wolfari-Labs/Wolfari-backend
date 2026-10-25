import { describe, expect, it } from 'vitest';
import {
  assertClosureAction,
  assertCreateClosure,
  ClosureRuleError,
  type ClosureAuthority,
} from './closure-management';
const owner = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const authority: ClosureAuthority = {
  actorUserId: owner,
  ownerUserId: owner,
  holderUserId: member,
  activeMemberUserIds: new Set([owner, member]),
  tripArchived: false,
  fundStatus: 'OPEN',
  financeVersion: 4,
};
describe('closure management rules', () => {
  it('allows only current Owner to create on an OPEN fund with active Holder', () => {
    expect(() => assertCreateClosure(4, authority)).not.toThrow();
    expect(() => assertCreateClosure(4, { ...authority, actorUserId: member })).toThrow(
      new ClosureRuleError('PERMISSION_DENIED'),
    );
    expect(() => assertCreateClosure(3, authority)).toThrow(
      new ClosureRuleError('VERSION_CONFLICT'),
    );
    expect(() =>
      assertCreateClosure(4, { ...authority, activeMemberUserIds: new Set([owner]) }),
    ).toThrow(new ClosureRuleError('STATE_CONFLICT'));
  });
  it('allows Self confirmation and keeps cancel/remind Owner-only during CLOSING', () => {
    const closing = {
      ...authority,
      actorUserId: member,
      fundStatus: 'CLOSING',
      closureStatus: 'PENDING_CONFIRMATIONS',
      closureUserIds: new Set([owner, member]),
    };
    expect(() => assertClosureAction('CONFIRM_CLOSURE', closing)).not.toThrow();
    expect(() => assertClosureAction('CANCEL_CLOSURE', closing)).toThrow(
      new ClosureRuleError('PERMISSION_DENIED'),
    );
    expect(() =>
      assertClosureAction('REMIND_CLOSURE', { ...closing, actorUserId: owner }),
    ).not.toThrow();
  });
});
