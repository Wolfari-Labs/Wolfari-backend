import type { DatabaseProvider } from '@wolfari/database';

type Client = Pick<DatabaseProvider, 'query'>;

/** Each kind is one rule the closure writer enforces; the readiness API reports the same counts. */
export const CLOSURE_BLOCKER_KINDS = [
  'BALANCE_NOT_ZERO',
  'CONTRIBUTIONS_OPEN',
  'EXPENSES_OPEN',
  'REFUNDS_OPEN',
  'PAYMENTS_OPEN',
  'PAYMENT_WEBHOOKS_OPEN',
  'HOLDER_HANDOVER_OPEN',
] as const;
export type ClosureBlockerKind = (typeof CLOSURE_BLOCKER_KINDS)[number];

export type ClosureCounts = {
  ledgerTotal: string;
  contributions: number;
  expenses: number;
  refunds: number;
  payments: number;
  webhooks: number;
  handovers: number;
  /** Advisory only: unmatched money is reviewed by the Holder but has no resolution writer yet. */
  bankTransfersNeedingReview: number;
};

/**
 * One query for both the closure writers and the readiness read, so the checklist can never
 * drift from the rule that rejects the closure.
 */
export async function closureCounts(client: Client, fundId: string): Promise<ClosureCounts> {
  const row = (
    await client.query<{
      ledger_total: string;
      contributions: number;
      expenses: number;
      refunds: number;
      payments: number;
      webhooks: number;
      handovers: number;
      bank_reviews: number;
    }>(
      `SELECT
       COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END) FROM fund_transactions WHERE fund_id=$1),0)::text AS ledger_total,
       (SELECT COUNT(*) FROM contributions WHERE fund_id=$1 AND status IN ('PENDING','TRANSFER_REPORTED'))::int AS contributions,
       (SELECT COUNT(*) FROM fund_expenses WHERE fund_id=$1 AND deleted_at IS NULL AND status IN ('DRAFT','SUBMITTED'))::int AS expenses,
       (SELECT COUNT(*) FROM fund_refunds WHERE fund_id=$1 AND
         (status IN ('PENDING','HOLDER_REPORTED') OR (status='CONFIRMED' AND reversal_requested_at IS NOT NULL)))::int AS refunds,
       (SELECT COUNT(*) FROM payment_attempts p JOIN contributions c ON c.id=p.contribution_id
         WHERE c.fund_id=$1 AND (p.needs_reconciliation OR p.status IN ('CREATED','PENDING') OR
           (p.status='SUCCEEDED' AND (c.status NOT IN ('CONFIRMED','REVERSED') OR NOT EXISTS
             (SELECT 1 FROM fund_transactions t WHERE t.fund_id=$1 AND t.contribution_id=c.id AND t.transaction_type='CONTRIBUTION')))))::int AS payments,
       (SELECT COUNT(*) FROM payment_webhook_receipts w JOIN payment_attempts p ON p.id=w.payment_attempt_id
         JOIN contributions c ON c.id=p.contribution_id WHERE c.fund_id=$1 AND w.signature_valid
         AND w.processing_status IN ('RECEIVED','NEEDS_REVIEW'))::int AS webhooks,
       (SELECT COUNT(*) FROM fund_holder_handovers WHERE fund_id=$1 AND status IN ('NOMINATED','ACCEPTED'))::int AS handovers,
       (SELECT COUNT(*) FROM bank_transfer_receipts WHERE fund_id=$1 AND processing_status='NEEDS_REVIEW')::int AS bank_reviews`,
      [fundId],
    )
  ).rows[0]!;
  return {
    ledgerTotal: row.ledger_total,
    contributions: Number(row.contributions),
    expenses: Number(row.expenses),
    refunds: Number(row.refunds),
    payments: Number(row.payments),
    webhooks: Number(row.webhooks),
    handovers: Number(row.handovers),
    bankTransfersNeedingReview: Number(row.bank_reviews),
  };
}

/** Blockers in display order; empty means a closure may be requested. */
export function closureBlockers(
  currentBalance: string,
  counts: ClosureCounts,
): { kind: ClosureBlockerKind; count: number }[] {
  const balanceOpen = BigInt(currentBalance) !== 0n || BigInt(counts.ledgerTotal) !== 0n;
  const list: [ClosureBlockerKind, number][] = [
    ['CONTRIBUTIONS_OPEN', counts.contributions],
    ['PAYMENTS_OPEN', counts.payments],
    ['PAYMENT_WEBHOOKS_OPEN', counts.webhooks],
    ['EXPENSES_OPEN', counts.expenses],
    ['REFUNDS_OPEN', counts.refunds],
    ['HOLDER_HANDOVER_OPEN', counts.handovers],
    ['BALANCE_NOT_ZERO', balanceOpen ? 1 : 0],
  ];
  return list.filter(([, count]) => count > 0).map(([kind, count]) => ({ kind, count }));
}

/** The writers' rule without the handover kind, which keeps its own HANDOVER_IN_PROGRESS error. */
export function blocksClosureWrite(currentBalance: string, counts: ClosureCounts): boolean {
  return closureBlockers(currentBalance, counts).some(
    (blocker) => blocker.kind !== 'HOLDER_HANDOVER_OPEN',
  );
}
