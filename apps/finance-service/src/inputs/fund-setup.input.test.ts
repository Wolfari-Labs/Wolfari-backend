import { describe, expect, it } from 'vitest';
import {
  assertCanEnableFund,
  assertCanUpdateFundBudget,
  FundSetupConflictError,
  FundSetupPermissionDeniedError,
} from '../domain/fund-setup';
import {
  FundSetupInputError,
  parseEnableFundInput,
  parseUpdateFundBudgetInput,
} from './fund-setup.input';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const holder = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bank = Object.freeze({
  destination_type: 'VIETQR',
  bank_code: 'TEST',
  account_number: '000123456',
  account_name: '  Nguyễn Văn A  ',
  is_default: true,
  active: true,
});
const momo = Object.freeze({
  destination_type: 'MOMO_SANDBOX',
  momo_phone: '0900000000',
  is_default: false,
  active: false,
});
const enable = Object.freeze({
  holder_user_id: holder.toUpperCase(),
  currency: 'VND',
  destination: bank,
});
const budget = Object.freeze({ budget_amount: '0', expected_finance_version: 3 });
const context = {
  actorUserId: owner,
  ownerUserId: owner,
  activeMemberUserIds: new Set([owner, holder]),
  tripArchived: false,
};

describe('API070 enable Fund input', () => {
  it('normalizes UUID, preserves destination strings and maps absent budget to null', () => {
    expect(parseEnableFundInput(enable)).toEqual({
      holderUserId: holder,
      currency: 'VND',
      budgetAmount: null,
      destination: {
        destinationType: 'VIETQR',
        bankCode: 'TEST',
        accountNumber: '000123456',
        accountName: '  Nguyễn Văn A  ',
        isDefault: true,
        active: true,
      },
    });
  });

  it('accepts the sandbox destination without inventing defaults or confirmation', () => {
    expect(parseEnableFundInput({ ...enable, destination: momo }).destination).toEqual({
      destinationType: 'MOMO_SANDBOX',
      momoPhone: '0900000000',
      isDefault: false,
      active: false,
    });
  });

  it.each(['0', '00042', '9007199254740993', '9223372036854775807'])(
    'parses budget %s exactly',
    (value) => {
      expect(parseEnableFundInput({ ...enable, budget_amount: value }).budgetAmount).toBe(
        BigInt(value),
      );
    },
  );

  it.each(['holder_user_id', 'currency', 'destination'])('requires own field %s', (key) => {
    const input: Record<string, unknown> = { ...enable };
    delete input[key];
    expect(() => parseEnableFundInput(input)).toThrow(new FundSetupInputError(key));
  });

  it.each([undefined, null, '', 'vnd', 'USD', 704])('rejects currency %s', (currency) => {
    expect(() => parseEnableFundInput({ ...enable, currency })).toThrow(
      new FundSetupInputError('currency'),
    );
  });

  it.each([
    undefined,
    null,
    '',
    holder + '\n',
    ' ' + holder,
    holder.replace('-4bbb-', '-0bbb-'),
    holder.replace('-8bbb-', '-7bbb-'),
    '00000000-0000-0000-0000-000000000000',
    1,
  ])('rejects malformed Holder UUID %s', (holder_user_id) => {
    expect(() => parseEnableFundInput({ ...enable, holder_user_id })).toThrow(
      new FundSetupInputError('holder_user_id'),
    );
  });

  it.each([
    'actor_user_id',
    'role',
    'owner_user_id',
    'current_balance',
    'status',
    'finance_version',
    'confirmed_by_holder_at',
    'trip_id',
    'idempotency_key',
    'expected_finance_version',
  ])('rejects extra/client-authority field %s', (key) => {
    expect(() => parseEnableFundInput({ ...enable, [key]: 'untrusted' })).toThrow(
      new FundSetupInputError('body'),
    );
  });

  it('rejects explicit null budget on enable, unlike the update API', () => {
    expect(() => parseEnableFundInput({ ...enable, budget_amount: null })).toThrow(
      new FundSetupInputError('budget_amount'),
    );
  });

  it.each([bank, momo])('copies $destination_type input and does not mutate it', (destination) => {
    const input = Object.freeze({ ...enable, destination });
    const before = structuredClone(input);
    const result = parseEnableFundInput(input);
    expect(input).toEqual(before);
    expect(result.destination).not.toBe(destination);
  });
});

describe('API072 update budget input', () => {
  it.each([null, '0', '9007199254740993', '9223372036854775807'])(
    'parses explicit budget %s including clear-to-null',
    (value) => {
      expect(parseUpdateFundBudgetInput({ ...budget, budget_amount: value })).toEqual({
        budgetAmount: value === null ? null : BigInt(value),
        expectedFinanceVersion: 3,
      });
    },
  );

  it.each(['budget_amount', 'expected_finance_version'])('requires %s', (key) => {
    const input: Record<string, unknown> = { ...budget };
    delete input[key];
    expect(() => parseUpdateFundBudgetInput(input)).toThrow(new FundSetupInputError(key));
  });

  it.each([0, -1, 1.1, NaN, Infinity, 2147483648, '3', true, null, undefined])(
    'rejects version %s without coercion',
    (expected_finance_version) => {
      expect(() => parseUpdateFundBudgetInput({ ...budget, expected_finance_version })).toThrow(
        new FundSetupInputError('expected_finance_version'),
      );
    },
  );

  it.each([1, 2147483647])('accepts int32 version boundary %s', (version) => {
    expect(
      parseUpdateFundBudgetInput({ ...budget, expected_finance_version: version })
        .expectedFinanceVersion,
    ).toBe(version);
  });

  it.each([
    'holder_user_id',
    'currency',
    'destination',
    'actor_user_id',
    'current_balance',
    'status',
    'version',
  ])('rejects attempts to change %s through the budget API', (key) => {
    expect(() => parseUpdateFundBudgetInput({ ...budget, [key]: 'untrusted' })).toThrow(
      new FundSetupInputError('body'),
    );
  });

  it('keeps a frozen update body unchanged', () => {
    expect(parseUpdateFundBudgetInput(budget)).toEqual({
      budgetAmount: 0n,
      expectedFinanceVersion: 3,
    });
    expect(budget).toEqual({ budget_amount: '0', expected_finance_version: 3 });
  });
});

describe('shared Fund input boundaries', () => {
  it.each([undefined, '', ' 1', '1\n', '-1', '1.5', '1e3', '9223372036854775808', 1, 1n, true, {}])(
    'rejects non-Money budget %s in either API',
    (budget_amount) => {
      expect(() => parseEnableFundInput({ ...enable, budget_amount })).toThrow(
        new FundSetupInputError('budget_amount'),
      );
      expect(() => parseUpdateFundBudgetInput({ ...budget, budget_amount })).toThrow(
        new FundSetupInputError('budget_amount'),
      );
    },
  );

  it.each([
    null,
    undefined,
    [],
    'body',
    1,
    new Date(),
    new Map(),
    Object.create({ holder_user_id: holder }),
  ])('rejects non-JSON-object bodies', (input) => {
    expect(() => parseEnableFundInput(input)).toThrow(FundSetupInputError);
    expect(() => parseUpdateFundBudgetInput(input)).toThrow(FundSetupInputError);
  });

  it('accepts plain objects with a null prototype', () => {
    const destination = Object.assign(Object.create(null) as Record<string, unknown>, bank);
    const input = Object.assign(Object.create(null) as Record<string, unknown>, enable, {
      destination,
    });
    expect(parseEnableFundInput(input)).toEqual(parseEnableFundInput(enable));
    expect(
      parseUpdateFundBudgetInput(
        Object.assign(Object.create(null) as Record<string, unknown>, budget),
      ),
    ).toEqual(parseUpdateFundBudgetInput(budget));
  });
});

describe('DestinationWrite within enable', () => {
  it.each([null, undefined, [], 'bank', new Date(), Object.create(bank)])(
    'rejects malformed destination object',
    (destination) => {
      expect(() => parseEnableFundInput({ ...enable, destination })).toThrow(
        new FundSetupInputError('destination'),
      );
    },
  );

  it.each([undefined, null, 'MOMO', 'MOMO_PRODUCTION', 'vietqr'])(
    'rejects unsupported type %s',
    (destination_type) => {
      expect(() =>
        parseEnableFundInput({ ...enable, destination: { ...bank, destination_type } }),
      ).toThrow(new FundSetupInputError('destination.destination_type'));
    },
  );

  it.each([
    'bank_code',
    'account_number',
    'account_name',
    'is_default',
    'active',
    'destination_type',
  ])('requires destination field %s', (key) => {
    const destination: Record<string, unknown> = { ...bank };
    delete destination[key];
    expect(() => parseEnableFundInput({ ...enable, destination })).toThrow(
      new FundSetupInputError(`destination.${key}`),
    );
  });

  it.each(['is_default', 'active'])('requires actual booleans for %s', (key) => {
    for (const value of [null, undefined, 0, 1, 'true', 'false']) {
      expect(() =>
        parseEnableFundInput({ ...enable, destination: { ...bank, [key]: value } }),
      ).toThrow(new FundSetupInputError(`destination.${key}`));
    }
  });

  it.each([
    { base: bank, key: 'bank_code', max: 30 },
    { base: bank, key: 'account_number', max: 80 },
    { base: bank, key: 'account_name', max: 150 },
    { base: momo, key: 'momo_phone', max: 30 },
  ])('validates destination $key without truncation or value disclosure', ({ base, key, max }) => {
    expect(() =>
      parseEnableFundInput({ ...enable, destination: { ...base, [key]: '😀'.repeat(max) } }),
    ).not.toThrow();
    for (const value of [
      undefined,
      null,
      123,
      '',
      ' \n',
      'secret\u0000value',
      '😀'.repeat(max + 1),
    ]) {
      expect(() =>
        parseEnableFundInput({ ...enable, destination: { ...base, [key]: value } }),
      ).toThrow(new FundSetupInputError(`destination.${key}`));
    }
  });

  it.each([
    'confirmed_by_holder_at',
    'holder_user_id',
    'version',
    'id',
    'destination_snapshot',
    'secret',
  ])('rejects forged destination field %s', (key) => {
    expect(() =>
      parseEnableFundInput({ ...enable, destination: { ...bank, [key]: 'untrusted' } }),
    ).toThrow(new FundSetupInputError('destination'));
  });

  it('rejects cross-type fields, including null, rather than dropping them silently', () => {
    expect(() =>
      parseEnableFundInput({ ...enable, destination: { ...bank, momo_phone: null } }),
    ).toThrow(new FundSetupInputError('destination'));
    expect(() =>
      parseEnableFundInput({ ...enable, destination: { ...momo, account_number: '0001' } }),
    ).toThrow(new FundSetupInputError('destination'));
  });

  it('keeps account values and unknown field names out of validation errors', () => {
    const privateValue = 'private-account\u0000value';
    for (const destination of [
      { ...bank, account_number: privateValue },
      { ...bank, [privateValue]: true },
    ]) {
      let caught: unknown;
      try {
        parseEnableFundInput({ ...enable, destination });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FundSetupInputError);
      expect(String(caught)).not.toContain(privateValue);
      expect(JSON.stringify(caught)).not.toContain('private-account');
      expect(String(caught)).not.toContain(bank.account_name);
    }
  });
});

describe('parsed commands still require domain checks', () => {
  it('valid JSON grants no Owner rights, Holder membership or permission on an archived Trip', () => {
    const command = parseEnableFundInput(enable);
    const trusted = { ...context, fundExists: false };
    expect(() => assertCanEnableFund(command, trusted)).not.toThrow();
    expect(() => assertCanEnableFund(command, { ...trusted, actorUserId: holder })).toThrow(
      FundSetupPermissionDeniedError,
    );
    expect(() =>
      assertCanEnableFund(command, { ...trusted, activeMemberUserIds: new Set([owner]) }),
    ).toThrow(new FundSetupConflictError('HOLDER_NOT_ACTIVE'));
    expect(() => assertCanEnableFund(command, { ...trusted, tripArchived: true })).toThrow(
      new FundSetupConflictError('TRIP_ARCHIVED'),
    );
    expect(() => assertCanEnableFund(command, { ...trusted, fundExists: true })).toThrow(
      new FundSetupConflictError('FUND_ALREADY_EXISTS'),
    );
  });

  it('rejects stale versions or closed Fund state after parsing a valid budget', () => {
    const command = parseUpdateFundBudgetInput({ ...budget, budget_amount: '9007199254740993' });
    const trusted = { ...context, fundStatus: 'OPEN' as const, financeVersion: 3 };
    expect(() => assertCanUpdateFundBudget(command, trusted)).not.toThrow();
    expect(command.budgetAmount).toBe(9007199254740993n);
    expect(() => assertCanUpdateFundBudget(command, { ...trusted, financeVersion: 4 })).toThrow(
      new FundSetupConflictError('FINANCE_VERSION_CONFLICT'),
    );
    expect(() => assertCanUpdateFundBudget(command, { ...trusted, fundStatus: 'CLOSED' })).toThrow(
      new FundSetupConflictError('FUND_NOT_OPEN'),
    );
  });
});
