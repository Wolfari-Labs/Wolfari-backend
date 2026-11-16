import { describe, expect, it } from 'vitest';
import {
  contributionTransferReference,
  decodeTransferReference,
  planBankTransfer,
  referencesInContent,
  type BankTransferCandidate,
} from './bank-transfer';

const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const reference = contributionTransferReference(id);
const candidate: BankTransferCandidate = {
  status: 'PENDING',
  amount: 300000n,
  version: 1,
  destinationType: 'VIETQR',
  destinationAccountNumber: '0011012345678',
  requestStatus: 'OPEN',
  fundStatus: 'OPEN',
  financeVersion: 3,
  hasLedgerEntry: false,
};
const receipt = { transferType: 'IN' as const, amount: 300000n, accountNumber: '0011012345678' };

describe('bank transfer references', () => {
  it('round-trips the API086 reference and rejects anything else', () => {
    expect(reference).toMatch(/^[0-9A-Z]{25}$/);
    expect(decodeTransferReference(reference)).toBe(id);
    expect(decodeTransferReference(reference.toLowerCase())).toBeUndefined();
    expect(decodeTransferReference('Z'.repeat(25))).toBeUndefined();
    expect(decodeTransferReference(reference.slice(1))).toBeUndefined();
    expect(decodeTransferReference('0'.repeat(25))).toBeUndefined();
  });
  it('finds references inside bank descriptions however the bank mangles them', () => {
    expect(referencesInContent(`CK ${reference.toLowerCase()} tien quy`)).toEqual([id]);
    expect(referencesInContent(`MBVCB.123.${reference}.CT tu 0011 toi 0022`)).toEqual([id]);
    expect(referencesInContent('thanh toan don hang')).toEqual([]);
    expect(referencesInContent(`${reference} ${reference}`)).toEqual([id]);
  });
});

describe('bank transfer decision', () => {
  it('matches only an exact, payable contribution on the instructed account', () => {
    expect(planBankTransfer(receipt, [id], candidate)).toEqual({ status: 'MATCHED', reason: null });
    expect(
      planBankTransfer(receipt, [id], { ...candidate, status: 'TRANSFER_REPORTED' }).status,
    ).toBe('MATCHED');
  });
  it.each([
    [{ ...receipt, transferType: 'OUT' as const }, [id], candidate, 'IGNORED', 'OUTGOING'],
    [receipt, [], candidate, 'UNMATCHED', 'NO_REFERENCE'],
    [receipt, [id], undefined, 'UNMATCHED', 'UNKNOWN_REFERENCE'],
    [receipt, [id, 'other'], candidate, 'NEEDS_REVIEW', 'MULTIPLE_REFERENCES'],
    [{ ...receipt, accountNumber: '9999' }, [id], candidate, 'NEEDS_REVIEW', 'ACCOUNT_MISMATCH'],
    [
      receipt,
      [id],
      { ...candidate, destinationType: 'MOMO_SANDBOX' },
      'NEEDS_REVIEW',
      'ACCOUNT_MISMATCH',
    ],
    [receipt, [id], { ...candidate, hasLedgerEntry: true }, 'NEEDS_REVIEW', 'ALREADY_CONFIRMED'],
    [receipt, [id], { ...candidate, status: 'CONFIRMED' }, 'NEEDS_REVIEW', 'ALREADY_CONFIRMED'],
    [
      receipt,
      [id],
      { ...candidate, status: 'CANCELLED' },
      'NEEDS_REVIEW',
      'CONTRIBUTION_NOT_PAYABLE',
    ],
    [receipt, [id], { ...candidate, fundStatus: 'CLOSING' }, 'NEEDS_REVIEW', 'FUND_NOT_OPEN'],
    [receipt, [id], { ...candidate, requestStatus: 'CLOSED' }, 'NEEDS_REVIEW', 'FUND_NOT_OPEN'],
    [{ ...receipt, amount: 299999n }, [id], candidate, 'NEEDS_REVIEW', 'AMOUNT_MISMATCH'],
    [receipt, [id], { ...candidate, version: 2147483647 }, 'NEEDS_REVIEW', 'VERSION_LIMIT'],
  ] as const)('records case %# instead of guessing', (rcpt, ids, cand, status, reason) => {
    expect(planBankTransfer(rcpt, [...ids], cand)).toEqual({ status, reason });
  });
  it('compares accounts ignoring spacing and case only', () => {
    expect(
      planBankTransfer({ ...receipt, accountNumber: ' 0011 0123 45678 ' }, [id], candidate).status,
    ).toBe('MATCHED');
  });
});
