import { describe, it, expect } from 'vitest';
import { planContributionManagement, type ManagementState } from './contribution-management';
import {
  parseContributionManagementInput as parse,
  type ContributionManagementScope,
} from '../inputs/contribution-management.input';
const state: ManagementState = {
  owner: true,
  fundOpen: true,
  requestOpen: true,
  version: 2,
  financeVersion: 5,
  title: 'Meals',
  note: null,
  dueAt: new Date('2026-10-20T00:00:00Z'),
  amount: '300000',
  pending: true,
  memberActive: true,
  blockedPayment: false,
  allPending: true,
};
const versions = { expected_version: 2, expected_finance_version: 5 };
describe('Contribution management policy and inputs', () => {
  it.each([
    {},
    { title: null },
    { title: '' },
    { title: '  ' },
    { title: 'a'.repeat(201) },
    { note: 'a\0b' },
    { due_at: null },
    { due_at: '2026-02-30T00:00:00Z' },
    { due_at: '2026-10-20' },
    { title: 'OK', actor_user_id: 'spoof' },
    { title: 'OK', expected_version: 0 },
    { title: 'OK', expected_finance_version: 2147483648 },
  ])('rejects invalid request patch %j', (body) =>
    expect(() => parse('UPDATE_CONTRIBUTION_REQUEST', { ...versions, ...body })).toThrow(),
  );
  it.each(['0', '-1', '1.5', '9223372036854775808', 1, null, undefined])(
    'rejects invalid amount %s',
    (amount) =>
      expect(() => parse('UPDATE_CONTRIBUTION_AMOUNT', { ...versions, amount })).toThrow(),
  );
  it.each(['WAIVE_CONTRIBUTION', 'CANCEL_CONTRIBUTION'] as const)(
    'requires a nonblank reason for %s',
    (scope) => {
      for (const reason of [undefined, null, '', '  ', 'a\0b', 12])
        expect(() => parse(scope, { ...versions, reason })).toThrow();
    },
  );
  it('normalizes exact int64 money and offset instants, permits empty note and Unicode title', () => {
    expect(
      parse('UPDATE_CONTRIBUTION_AMOUNT', { ...versions, amount: '0009223372036854775807' }).amount,
    ).toBe(9223372036854775807n);
    const body = parse('UPDATE_CONTRIBUTION_REQUEST', {
      ...versions,
      due_at: '2026-10-20T07:00:00+07:00',
      note: '',
      title: '😀'.repeat(200),
    });
    expect(body.dueAt).toEqual(state.dueAt);
    expect(body.note).toBe('');
  });
  const commands: [ContributionManagementScope, object][] = [
    ['UPDATE_CONTRIBUTION_REQUEST', { title: 'Changed' }],
    ['UPDATE_CONTRIBUTION_AMOUNT', { amount: '400000' }],
    ['WAIVE_CONTRIBUTION', { reason: 'Group paid' }],
    ['CANCEL_CONTRIBUTION', { reason: 'Wrong allocation' }],
  ];
  it.each(commands)('checks authority, lifecycle and versions for %s', (scope, fields) => {
    const body = parse(scope, { ...versions, ...fields });
    for (const patch of [
      { owner: false },
      { fundOpen: false },
      { requestOpen: false },
      { version: 3 },
      { financeVersion: 6 },
    ])
      expect(() => planContributionManagement(scope, body, { ...state, ...patch })).toThrow();
    expect(planContributionManagement(scope, body, state)).toEqual({
      changed: true,
      version: 3,
      financeVersion: 6,
    });
  });
  it('metadata changes support mixed children but changed deadlines require all pending and no payment', () => {
    const mixed = { ...state, allPending: false, blockedPayment: true };
    expect(
      planContributionManagement(
        'UPDATE_CONTRIBUTION_REQUEST',
        parse('UPDATE_CONTRIBUTION_REQUEST', { ...versions, title: 'New' }),
        mixed,
      ).changed,
    ).toBe(true);
    expect(
      planContributionManagement(
        'UPDATE_CONTRIBUTION_REQUEST',
        parse('UPDATE_CONTRIBUTION_REQUEST', { ...versions, due_at: '2026-10-20T07:00:00+07:00' }),
        mixed,
      ).changed,
    ).toBe(false);
    for (const patch of [{ allPending: false }, { blockedPayment: true }])
      expect(() =>
        planContributionManagement(
          'UPDATE_CONTRIBUTION_REQUEST',
          parse('UPDATE_CONTRIBUTION_REQUEST', { ...versions, due_at: '2026-10-21T00:00:00Z' }),
          { ...state, ...patch },
        ),
      ).toThrow();
  });
  it.each(commands.slice(1))('blocks unsafe target even for amount no-op: %s', (scope, fields) => {
    for (const patch of [{ pending: false }, { memberActive: false }, { blockedPayment: true }])
      expect(() =>
        planContributionManagement(scope, parse(scope, { ...versions, ...fields }), {
          ...state,
          ...patch,
        }),
      ).toThrow();
  });
  it('no-op still checks versions but can replay at maximum without overflow', () => {
    const max = { ...state, version: 2147483647, financeVersion: 2147483647 };
    const body = parse('UPDATE_CONTRIBUTION_AMOUNT', {
      expected_version: max.version,
      expected_finance_version: max.financeVersion,
      amount: '000300000',
    });
    expect(planContributionManagement('UPDATE_CONTRIBUTION_AMOUNT', body, max).changed).toBe(false);
    expect(() =>
      planContributionManagement('UPDATE_CONTRIBUTION_AMOUNT', { ...body, amount: 1n }, max),
    ).toThrow();
    expect(() =>
      planContributionManagement(
        'UPDATE_CONTRIBUTION_AMOUNT',
        { ...body, expectedVersion: 1 },
        max,
      ),
    ).toThrow();
  });
});
