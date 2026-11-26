import { contributionTransferReference } from '@wolfari/common';
import { UUID } from '../finance.errors';
import { VIETQR_BANKS, findVietQrBank } from './vietqr-banks';

/**
 * Pure rules for incoming bank transfers reported by an aggregation provider (SePay).
 * The transfer content is matched to a contribution through the 25-character base36
 * reference that API086 prints as the transfer content; nothing else is trusted.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The transfer content shown to the member for this contribution (same formula as API086). */
export { contributionTransferReference };

/** Inverse of contributionTransferReference; undefined unless the token round-trips exactly. */
export function decodeTransferReference(token: string): string | undefined {
  if (!/^[0-9A-Z]{25}$/.test(token)) return undefined;
  let value = 0n;
  for (const char of token) value = value * 36n + BigInt(ALPHABET.indexOf(char));
  const hex = value.toString(16);
  if (hex.length > 32) return undefined;
  const padded = hex.padStart(32, '0');
  const id = `${padded.slice(0, 8)}-${padded.slice(8, 12)}-${padded.slice(12, 16)}-${padded.slice(16, 20)}-${padded.slice(20)}`;
  if (!UUID.test(id) || contributionTransferReference(id) !== token) return undefined;
  return id;
}

/** Candidate contribution IDs named in a transfer description (banks upper-case and may pad it). */
export function referencesInContent(content: string): string[] {
  const found = new Set<string>();
  for (const token of content.toUpperCase().split(/[^0-9A-Z]+/)) {
    if (token.length !== 25) continue;
    const id = decodeTransferReference(token);
    if (id) found.add(id);
    if (found.size >= 5) break;
  }
  return [...found];
}

export const normalizeAccountNumber = (value: string) => value.replace(/\s+/g, '').toUpperCase();

// SePay reports names such as Vietcombank and MBBank in the gateway field.
export function resolveSepayBankCode(gateway: string | null): string | undefined {
  const value = gateway?.trim().normalize('NFC').toUpperCase();
  if (!value) return undefined;
  const matches = VIETQR_BANKS.filter(
    (bank) =>
      bank.transfer_supported &&
      [bank.code, bank.bin, bank.short_name, bank.name].some(
        (name) => name.normalize('NFC').toUpperCase() === value,
      ),
  );
  return matches.length === 1 ? matches[0]?.code : undefined;
}

export type BankTransferReview =
  | 'OUTGOING'
  | 'NO_REFERENCE'
  | 'UNKNOWN_REFERENCE'
  | 'MULTIPLE_REFERENCES'
  | 'ACCOUNT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CONTRIBUTION_NOT_PAYABLE'
  | 'ALREADY_CONFIRMED'
  | 'FUND_NOT_OPEN'
  | 'VERSION_LIMIT';

export type BankTransferDecision =
  | { status: 'IGNORED'; reason: 'OUTGOING' }
  | { status: 'UNMATCHED'; reason: 'NO_REFERENCE' | 'UNKNOWN_REFERENCE' }
  | {
      status: 'NEEDS_REVIEW';
      reason: Exclude<BankTransferReview, 'OUTGOING' | 'NO_REFERENCE' | 'UNKNOWN_REFERENCE'>;
    }
  | { status: 'MATCHED'; reason: null };

export type BankTransferCandidate = Readonly<{
  status: string;
  amount: bigint;
  version: number;
  destinationType: string;
  destinationAccountNumber: string;
  destinationBankCode: string;
  requestStatus: string;
  fundStatus: string;
  financeVersion: number;
  hasLedgerEntry: boolean;
}>;

/**
 * Decide what one incoming transfer does. MATCHED only when the money reached the very account
 * the member was told to pay, for exactly the contribution amount, while that contribution can
 * still be confirmed. Everything else is recorded for the Holder instead of guessed.
 */
export function planBankTransfer(
  receipt: Readonly<{
    transferType: 'IN' | 'OUT';
    amount: bigint;
    accountNumber: string;
    bankCode?: string;
  }>,
  candidates: ReadonlyArray<string>,
  candidate: BankTransferCandidate | undefined,
): BankTransferDecision {
  if (receipt.transferType === 'OUT') return { status: 'IGNORED', reason: 'OUTGOING' };
  if (candidates.length === 0) return { status: 'UNMATCHED', reason: 'NO_REFERENCE' };
  if (candidates.length > 1) return { status: 'NEEDS_REVIEW', reason: 'MULTIPLE_REFERENCES' };
  if (!candidate) return { status: 'UNMATCHED', reason: 'UNKNOWN_REFERENCE' };
  if (
    candidate.destinationType !== 'VIETQR' ||
    !receipt.bankCode ||
    findVietQrBank(candidate.destinationBankCode)?.code !== receipt.bankCode ||
    normalizeAccountNumber(candidate.destinationAccountNumber) !==
      normalizeAccountNumber(receipt.accountNumber)
  )
    return { status: 'NEEDS_REVIEW', reason: 'ACCOUNT_MISMATCH' };
  if (candidate.hasLedgerEntry || candidate.status === 'CONFIRMED')
    return { status: 'NEEDS_REVIEW', reason: 'ALREADY_CONFIRMED' };
  if (!['PENDING', 'TRANSFER_REPORTED'].includes(candidate.status))
    return { status: 'NEEDS_REVIEW', reason: 'CONTRIBUTION_NOT_PAYABLE' };
  if (candidate.requestStatus !== 'OPEN' || candidate.fundStatus !== 'OPEN')
    return { status: 'NEEDS_REVIEW', reason: 'FUND_NOT_OPEN' };
  if (candidate.amount !== receipt.amount)
    return { status: 'NEEDS_REVIEW', reason: 'AMOUNT_MISMATCH' };
  if (candidate.version >= 2147483647 || candidate.financeVersion >= 2147483647)
    return { status: 'NEEDS_REVIEW', reason: 'VERSION_LIMIT' };
  return { status: 'MATCHED', reason: null };
}
