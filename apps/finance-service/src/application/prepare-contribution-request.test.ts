import { describe, expect, it } from 'vitest';
import { prepareContributionRequest } from './prepare-contribution-request';
import type { PaymentDestinationRecord } from '../repositories/payment-destination.repository';
import type { CreateContributionRequestCommand } from '../domain/contribution-request-creation';
import { ContributionPermissionDeniedError } from '../domain/contribution-permissions';
import { InvalidContributionRequestError } from '../domain/contribution-request';

// IDs here have already crossed the UUID input boundary.
const date = new Date('2026-10-01T00:00:00Z');
const bank: PaymentDestinationRecord = {
  id: 'bank',
  fundId: 'fund',
  destinationType: 'VIETQR',
  bankCode: 'TEST',
  accountNumber: '00000123',
  accountName: 'TEST HOLDER',
  momoPhone: null,
  active: true,
  isDefault: true,
  version: 2,
  confirmedByHolderAt: date,
  createdAt: date,
  updatedAt: date,
};
const momo: PaymentDestinationRecord = {
  ...bank,
  id: 'momo',
  destinationType: 'MOMO_SANDBOX',
  bankCode: null,
  accountNumber: null,
  accountName: null,
  momoPhone: '0900000000',
};
const context = {
  fundId: 'fund',
  actorUserId: 'owner',
  ownerUserId: 'owner',
  fundStatus: 'OPEN' as const,
  financeVersion: 4,
  activeMemberUserIds: new Set(['owner', 'member']),
};
const command: CreateContributionRequestCommand = {
  title: ' Trip fund ',
  note: null,
  dueAt: date,
  expectedFinanceVersion: 4,
  contributions: [
    { memberUserId: 'member', amount: 9007199254740993n, destinationId: 'bank' },
    { memberUserId: 'owner', amount: 1n, destinationId: 'momo' },
  ],
};

describe('preparing a contribution request', () => {
  it('matches by selected ID regardless of row order and preserves allocation order and exact money', () => {
    const result = prepareContributionRequest(command, context, [momo, bank]);
    expect(result).toEqual({
      ...command,
      contributions: [
        { memberUserId: 'member', amount: 9007199254740993n, destination: bank },
        { memberUserId: 'owner', amount: 1n, destination: momo },
      ],
    });
  });

  it('does not silently drop an allocation with a missing or wrong-Fund destination', () => {
    for (const records of [[bank], [bank, { ...momo, fundId: 'other' }]]) {
      expect(() => prepareContributionRequest(command, context, records)).toThrow(
        InvalidContributionRequestError,
      );
    }
  });

  it('does not choose a default instead of the requested ID', () => {
    expect(() =>
      prepareContributionRequest(
        { ...command, contributions: [{ ...command.contributions[0], destinationId: 'missing' }] },
        context,
        [bank],
      ),
    ).toThrow(InvalidContributionRequestError);
  });

  it.each([{ active: false }, { confirmedByHolderAt: null }])(
    'rejects an ineligible selected destination %#',
    (patch) => {
      expect(() =>
        prepareContributionRequest(command, context, [{ ...bank, ...patch }, momo]),
      ).toThrow(InvalidContributionRequestError);
    },
  );

  it('still checks Owner authorization and current state/version', () => {
    expect(() =>
      prepareContributionRequest(command, { ...context, actorUserId: 'member' }, [bank, momo]),
    ).toThrow(ContributionPermissionDeniedError);
    expect(() =>
      prepareContributionRequest(command, { ...context, fundStatus: 'CLOSED' }, [bank, momo]),
    ).toThrow();
    expect(() =>
      prepareContributionRequest(command, { ...context, financeVersion: 5 }, [bank, momo]),
    ).toThrow();
  });

  it('rejects ambiguous duplicate stored IDs in the same Fund', () => {
    expect(() =>
      prepareContributionRequest(command, context, [bank, { ...bank, version: 3 }, momo]),
    ).toThrow(InvalidContributionRequestError);
  });

  it.each([0, 1.5, 2147483648])('rejects invalid stored destination version %s', (version) => {
    expect(() =>
      prepareContributionRequest(command, context, [{ ...bank, version }, momo]),
    ).toThrow(InvalidContributionRequestError);
  });

  it.each(['bankCode', 'accountNumber', 'accountName'] as const)(
    'rejects missing VIETQR detail %s',
    (field) => {
      expect(() =>
        prepareContributionRequest(command, context, [{ ...bank, [field]: null }, momo]),
      ).toThrow(InvalidContributionRequestError);
      expect(() =>
        prepareContributionRequest(command, context, [{ ...bank, [field]: '  ' }, momo]),
      ).toThrow(InvalidContributionRequestError);
    },
  );

  it('rejects missing MoMo details and unsupported destination types', () => {
    expect(() =>
      prepareContributionRequest(command, context, [bank, { ...momo, momoPhone: null }]),
    ).toThrow(InvalidContributionRequestError);
    expect(() =>
      prepareContributionRequest(command, context, [
        { ...bank, destinationType: 'UNKNOWN' as PaymentDestinationRecord['destinationType'] },
        momo,
      ]),
    ).toThrow(InvalidContributionRequestError);
  });

  it('rejects invalid stored confirmation timestamps', () => {
    expect(() =>
      prepareContributionRequest(command, context, [
        { ...bank, confirmedByHolderAt: new Date('invalid') },
        momo,
      ]),
    ).toThrow(InvalidContributionRequestError);
  });

  it('detaches metadata and every selected destination, even when two members use the same ID', () => {
    const source = { ...structuredClone(bank) };
    const input = {
      ...command,
      dueAt: new Date(date),
      contributions: command.contributions.map((item) => ({ ...item, destinationId: 'bank' })),
    };
    const result = prepareContributionRequest(input, context, [source]);
    source.accountNumber = 'changed';
    source.confirmedByHolderAt?.setUTCFullYear(2030);
    input.dueAt.setUTCFullYear(2030);
    const sourceUpdatedAt = new Date(source.updatedAt);
    expect(result.dueAt).toEqual(date);
    expect(result.contributions[0].destination.accountNumber).toBe('00000123');
    expect(result.contributions[0].destination.confirmedByHolderAt).toEqual(date);
    result.contributions[0].destination.updatedAt.setUTCFullYear(2040);
    expect(result.contributions[1].destination.updatedAt).toEqual(date);
    expect(source.updatedAt).toEqual(sourceUpdatedAt);
  });

  it('preserves null optional metadata and does not copy undeclared stored fields', () => {
    const result = prepareContributionRequest({ ...command, dueAt: null }, context, [
      { ...bank, extra: 'not selected' } as PaymentDestinationRecord,
      momo,
    ]);
    expect(result.dueAt).toBeNull();
    expect(result.note).toBeNull();
    expect(result.contributions[0].destination).not.toHaveProperty('extra');
  });
});
