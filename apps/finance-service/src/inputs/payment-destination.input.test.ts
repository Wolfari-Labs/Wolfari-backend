import { describe, expect, it } from 'vitest';
import {
  parseCreatePaymentDestinationInput as create,
  parseConfirmPaymentDestinationInput as confirm,
  parseUpdatePaymentDestinationInput as update,
  PaymentDestinationInputError,
} from './payment-destination.input';
import { prepareUpdatePaymentDestination } from '../domain/payment-destination-management';

const bank = {
  destination_type: 'VIETQR',
  bank_code: 'TEST',
  account_number: '00123',
  account_name: 'TEST HOLDER',
  is_default: true,
  active: true,
};
const momo = {
  destination_type: 'MOMO_SANDBOX',
  momo_phone: '00111',
  is_default: false,
  active: true,
};
const versions = { expected_version: 3, expected_finance_version: 7 };

describe('API074/075/076 destination body parsing', () => {
  it('parses flat create bodies for both providers without dropping leading zeroes', () => {
    expect(create({ ...bank, expected_finance_version: 7 })).toEqual({
      destination: {
        destinationType: 'VIETQR',
        bankCode: 'TEST',
        accountNumber: '00123',
        accountName: 'TEST HOLDER',
        isDefault: true,
        active: true,
      },
      expectedFinanceVersion: 7,
    });
    expect(create({ ...momo, expected_finance_version: 7 }).destination).toMatchObject({
      momoPhone: '00111',
    });
    expect(() => create({ destination: bank, expected_finance_version: 7 })).toThrow(
      PaymentDestinationInputError,
    );
  });
  it('accepts only the two versions for confirmation', () => {
    expect(confirm(versions)).toEqual({ expectedVersion: 3, expectedFinanceVersion: 7 });
  });
  it('preserves false and omission in a partial update; does not modify input', () => {
    const input = Object.freeze({ active: false, ...versions });
    expect(update(input)).toEqual({
      patch: { active: false },
      expectedVersion: 3,
      expectedFinanceVersion: 7,
    });
    expect(Object.keys(update(input).patch)).toEqual(['active']);
    expect(update({ is_default: false, ...versions }).patch).toEqual({ isDefault: false });
  });
  it.each([
    'destination_type',
    'bank_code',
    'account_number',
    'account_name',
    'is_default',
    'active',
  ])('requires %s in a VIETQR create body', (field) => {
    const input: Record<string, unknown> = { ...bank, expected_finance_version: 7 };
    delete input[field];
    expect(() => create(input)).toThrow(PaymentDestinationInputError);
  });
  it.each([
    'actor_user_id',
    'fund_id',
    'confirmed_by_holder_at',
    'version',
    'balance',
    'owner_user_id',
    'private-value-key',
  ])('rejects forged/unknown field %s in each parser without echoing it', (field) => {
    for (const [parser, input] of [
      [create, { ...bank, expected_finance_version: 7 }],
      [confirm, versions],
      [update, { ...versions, active: true }],
    ] as const) {
      try {
        parser({ ...input, [field]: 'PRIVATE' });
        expect.fail('must reject');
      } catch (error) {
        expect(error).toBeInstanceOf(PaymentDestinationInputError);
        expect((error as Error).message).not.toContain('PRIVATE');
        expect((error as Error).message).not.toContain(field);
      }
    }
  });
  it.each([null, [], 'body', 1, new Date(), Object.create({ active: true }) as unknown])(
    'rejects non-plain body %j',
    (input) => {
      for (const parser of [create, confirm, update])
        expect(() => parser(input)).toThrow(PaymentDestinationInputError);
    },
  );
  it('supports own fields of a null-prototype object', () => {
    const input: unknown = Object.assign(Object.create(null), versions, { active: false });
    expect(update(input).patch).toEqual({ active: false });
  });
  it.each([undefined, null, '7', 0, -1, 1.1, NaN, Infinity, 2147483648])(
    'rejects invalid expected versions %j',
    (value) => {
      expect(() => create({ ...bank, expected_finance_version: value })).toThrow();
      for (const field of ['expected_version', 'expected_finance_version']) {
        expect(() => confirm({ ...versions, [field]: value })).toThrow();
        expect(() => update({ ...versions, active: true, [field]: value })).toThrow();
      }
    },
  );
  it('rejects empty patches and missing versions', () => {
    expect(() => update(versions)).toThrow('patch');
    expect(() => update({ active: true })).toThrow();
    expect(() => confirm({ expected_version: 3 })).toThrow();
    expect(() => create(bank)).toThrow();
  });
  it.each(['active', 'is_default'])('does not coerce boolean field %s', (field) => {
    for (const value of [undefined, null, 'false', 0, 1])
      expect(() => update({ ...versions, [field]: value })).toThrow();
  });
  it.each([
    ['bank_code', 30],
    ['account_number', 80],
    ['account_name', 150],
    ['momo_phone', 30],
  ] as const)('validates Unicode bounds and blank/NUL/null for %s', (field, max) => {
    expect(() => update({ ...versions, [field]: '𠮷'.repeat(max) })).not.toThrow();
    for (const value of ['𠮷'.repeat(max + 1), '', '  ', '\u0000', null, undefined, 123]) {
      expect(() => update({ ...versions, [field]: value })).toThrow(PaymentDestinationInputError);
    }
  });
  it('rejects fields from the other provider on create, including null', () => {
    expect(() => create({ ...bank, momo_phone: null, expected_finance_version: 7 })).toThrow();
    expect(() => create({ ...momo, account_number: '001', expected_finance_version: 7 })).toThrow();
  });
  it('does not treat a syntactically valid provider change as an allowed domain transition', () => {
    const command = update({ ...versions, destination_type: 'MOMO_SANDBOX', momo_phone: '00111' });
    const destination = create({ ...bank, expected_finance_version: 7 }).destination;
    const context = {
      actorUserId: 'owner',
      ownerUserId: 'owner',
      holderUserId: 'holder',
      activeMemberUserIds: new Set(['owner', 'holder']),
      tripArchived: false,
      fundId: 'fund',
      fundStatus: 'OPEN' as const,
      financeVersion: 7,
    };
    const state = {
      id: 'target',
      fundId: 'fund',
      configuration: destination,
      version: 3,
      confirmedByHolderAt: null,
    };
    expect(() => prepareUpdatePaymentDestination(command, context, state, state)).toThrow(
      'DESTINATION_TYPE_IMMUTABLE',
    );
    expect(() =>
      prepareUpdatePaymentDestination(
        update({ ...versions, is_default: false }),
        { ...context, actorUserId: 'holder' },
        state,
        state,
      ),
    ).toThrow('Actor cannot');
  });
});
