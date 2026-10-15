import { describe, expect, it } from 'vitest';
import {
  assertCanEnableFund,
  assertCanUpdateFundBudget,
  assertValidFundDestination,
  FundSetupConflictError,
  FundSetupPermissionDeniedError,
  FundSetupValidationError,
  type EnableFundCommand,
  type EnableFundContext,
  type FundDestination,
  type UpdateFundBudgetContext,
} from './fund-setup';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const holder = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const member = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bank: FundDestination = Object.freeze({
  destinationType: 'VIETQR',
  bankCode: 'TEST',
  accountNumber: '000123456',
  accountName: 'NGUYEN VAN A',
  isDefault: true,
  active: true,
});
const momo: FundDestination = Object.freeze({
  destinationType: 'MOMO_SANDBOX',
  momoPhone: '0900000000',
  isDefault: false,
  active: false,
});
const command: EnableFundCommand = Object.freeze({
  holderUserId: holder,
  currency: 'VND',
  budgetAmount: 9007199254740993n,
  destination: bank,
});
const context: EnableFundContext = Object.freeze({
  actorUserId: owner,
  ownerUserId: owner,
  activeMemberUserIds: new Set([owner, holder, member]),
  tripArchived: false,
  fundExists: false,
});
const budgetContext: UpdateFundBudgetContext = Object.freeze({
  actorUserId: owner,
  ownerUserId: owner,
  activeMemberUserIds: context.activeMemberUserIds,
  tripArchived: false,
  fundStatus: 'OPEN',
  financeVersion: 3,
});
const budgetCommand = Object.freeze({ budgetAmount: 0n, expectedFinanceVersion: 3 });

describe('Fund setup domain', () => {
  it('rejects an inactive initial default consistently with destination creation', () => {
    expect(() =>
      assertCanEnableFund({ ...command, destination: { ...bank, active: false } }, context),
    ).toThrow(new FundSetupConflictError('INACTIVE_DEFAULT'));
  });

  it.each([holder, owner])('allows an active Owner to choose active Holder %s', (holderUserId) => {
    expect(() => assertCanEnableFund({ ...command, holderUserId }, context)).not.toThrow();
  });

  it.each([bank, momo])(
    'checks configuration without adding Holder consent for $destinationType',
    (destination) => {
      const input = Object.freeze({ ...command, destination });
      const before = structuredClone(input);
      expect(assertCanEnableFund(input, context)).toBeUndefined();
      expect(input).toEqual(before);
      expect(Object.hasOwn(destination, 'confirmedByHolderAt')).toBe(false);
      expect([...context.activeMemberUserIds]).toEqual([owner, holder, member]);
    },
  );

  it.each([null, 0n, 9007199254740993n, 9223372036854775807n])(
    'allows optional/non-negative budget %s without changing the command',
    (budgetAmount) => {
      const enable = Object.freeze({ ...command, budgetAmount });
      const update = Object.freeze({ ...budgetCommand, budgetAmount });
      expect(assertCanEnableFund(enable, context)).toBeUndefined();
      expect(assertCanUpdateFundBudget(update, budgetContext)).toBeUndefined();
      expect(enable.budgetAmount).toBe(budgetAmount);
      expect(update).toEqual({ budgetAmount, expectedFinanceVersion: 3 });
      expect(budgetContext.financeVersion).toBe(3);
    },
  );

  it.each([holder, member])('rejects active non-Owner %s for both commands', (actorUserId) => {
    expect(() => assertCanEnableFund(command, { ...context, actorUserId })).toThrow(
      FundSetupPermissionDeniedError,
    );
    expect(() =>
      assertCanUpdateFundBudget(budgetCommand, { ...budgetContext, actorUserId }),
    ).toThrow(FundSetupPermissionDeniedError);
  });

  it('rejects an Owner who is no longer active', () => {
    const activeMemberUserIds = new Set([holder, member]);
    expect(() => assertCanEnableFund(command, { ...context, activeMemberUserIds })).toThrow(
      FundSetupPermissionDeniedError,
    );
    expect(() =>
      assertCanUpdateFundBudget(budgetCommand, { ...budgetContext, activeMemberUserIds }),
    ).toThrow(FundSetupPermissionDeniedError);
  });

  it('rejects an archived Trip for enable and budget update', () => {
    expect(() => assertCanEnableFund(command, { ...context, tripArchived: true })).toThrow(
      new FundSetupConflictError('TRIP_ARCHIVED'),
    );
    expect(() =>
      assertCanUpdateFundBudget(budgetCommand, { ...budgetContext, tripArchived: true }),
    ).toThrow(new FundSetupConflictError('TRIP_ARCHIVED'));
  });

  it('rejects a new enable intent when any Fund already exists', () => {
    expect(() => assertCanEnableFund(command, { ...context, fundExists: true })).toThrow(
      new FundSetupConflictError('FUND_ALREADY_EXISTS'),
    );
  });

  it('rejects a Holder outside the active membership set', () => {
    expect(() =>
      assertCanEnableFund(command, {
        ...context,
        activeMemberUserIds: new Set([owner, member]),
      }),
    ).toThrow(new FundSetupConflictError('HOLDER_NOT_ACTIVE'));
  });

  it.each(['CLOSING', 'CLOSED'] as const)('rejects budget changes on %s funds', (fundStatus) => {
    expect(() =>
      assertCanUpdateFundBudget(budgetCommand, { ...budgetContext, fundStatus }),
    ).toThrow(new FundSetupConflictError('FUND_NOT_OPEN'));
  });

  it('rejects a stale expected Finance version', () => {
    expect(() =>
      assertCanUpdateFundBudget({ ...budgetCommand, expectedFinanceVersion: 2 }, budgetContext),
    ).toThrow(new FundSetupConflictError('FINANCE_VERSION_CONFLICT'));
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, '3', null, undefined])(
    'rejects malformed expected or stored version %s',
    (value) => {
      expect(() =>
        assertCanUpdateFundBudget(
          { ...budgetCommand, expectedFinanceVersion: value as number },
          budgetContext,
        ),
      ).toThrow(RangeError);
      expect(() =>
        assertCanUpdateFundBudget(budgetCommand, {
          ...budgetContext,
          financeVersion: value as number,
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([1, 2147483647])(
    'validates matching version boundary %s without incrementing it',
    (version) => {
      expect(() =>
        assertCanUpdateFundBudget(
          { ...budgetCommand, expectedFinanceVersion: version },
          { ...budgetContext, financeVersion: version },
        ),
      ).not.toThrow();
    },
  );

  it.each([-1n, 9223372036854775808n, '100', 100, undefined])(
    'rejects invalid internal budget %s even without the JSON parser',
    (value) => {
      expect(() =>
        assertCanEnableFund({ ...command, budgetAmount: value as bigint }, context),
      ).toThrow();
      expect(() =>
        assertCanUpdateFundBudget(
          { ...budgetCommand, budgetAmount: value as bigint },
          budgetContext,
        ),
      ).toThrow();
    },
  );

  it('rejects unsupported currency even without the JSON parser', () => {
    expect(() => assertCanEnableFund({ ...command, currency: 'USD' as 'VND' }, context)).toThrow(
      new FundSetupValidationError('currency'),
    );
  });

  it('revalidates destination data when called without the JSON parser', () => {
    const destination = { ...bank, accountNumber: ' ' } as FundDestination;
    expect(() => assertCanEnableFund({ ...command, destination }, context)).toThrow(
      new FundSetupValidationError('destination.account_number'),
    );
  });
});

describe('Fund destination values', () => {
  it.each([
    { base: bank, key: 'bankCode', field: 'bank_code', max: 30 },
    { base: bank, key: 'accountNumber', field: 'account_number', max: 80 },
    { base: bank, key: 'accountName', field: 'account_name', max: 150 },
    { base: momo, key: 'momoPhone', field: 'momo_phone', max: 30 },
  ])('validates $field text and PostgreSQL character limit', ({ base, key, field, max }) => {
    expect(() =>
      assertValidFundDestination({ ...base, [key]: '😀'.repeat(max) } as FundDestination),
    ).not.toThrow();
    for (const value of [
      '',
      ' \t\n',
      'private\u0000value',
      '😀'.repeat(max + 1),
      null,
      undefined,
      123,
    ]) {
      expect(() =>
        assertValidFundDestination({ ...base, [key]: value } as FundDestination),
      ).toThrow(new FundSetupValidationError(`destination.${field}`));
    }
  });

  it.each(['isDefault', 'active'])('requires boolean %s without coercion', (key) => {
    for (const value of [undefined, null, 0, 1, 'true', 'false']) {
      expect(() =>
        assertValidFundDestination({ ...bank, [key]: value } as FundDestination),
      ).toThrow(FundSetupValidationError);
    }
  });

  it.each([null, undefined, 'VIETQR', { ...bank, destinationType: 'MOMO_PRODUCTION' }])(
    'rejects invalid destination shape or type',
    (value) => {
      expect(() => assertValidFundDestination(value as FundDestination)).toThrow(
        FundSetupValidationError,
      );
    },
  );
});
