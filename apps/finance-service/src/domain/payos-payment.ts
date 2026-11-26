import { randomInt } from 'node:crypto';
import type { PayosLinkStatus } from '../providers/payos.provider';

/** 12-digit payOS order code; uniqueness is enforced by uq_payment_attempts_2. */
export function newPayosOrderCode(random: (min: number, max: number) => number = randomInt) {
  return random(100_000_000_000, 1_000_000_000_000);
}

/**
 * Transfer content shown in the payer's bank app. payOS allows only 9 characters for accounts
 * that are not linked through payOS, so stay within that bound for every bank.
 */
export function payosDescription(orderCode: number) {
  return `WF${orderCode.toString(36).toUpperCase().slice(-7)}`;
}

export type PayosAttemptOutcome = 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'REVIEW';
/** UNDERPAID is money in the account that does not settle the contribution: Holder review. */
export function classifyPayosStatus(status: PayosLinkStatus): PayosAttemptOutcome {
  if (status === 'PAID') return 'SUCCEEDED';
  if (status === 'PENDING' || status === 'PROCESSING') return 'PENDING';
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'UNDERPAID') return 'REVIEW';
  return 'FAILED';
}

/** A paid webhook carries `code` "00"; anything else never moves money on its own. */
export const payosWebhookPaid = (code: string) => code === '00';

/** payOS bank references (e.g. FT23…, TF2302…) stored as the provider transaction id. */
export const PAYOS_REFERENCE = /^[A-Za-z0-9._:-]{1,100}$/;
