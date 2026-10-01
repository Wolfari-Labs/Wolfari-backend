import {
  assertContributionActionAllowed,
  type ContributionPermissionContext,
} from './contribution-permissions';
import { calculateBalanceAfterEntry } from './ledger-balance';
import { assertVndAmount } from './money';

export type ContributionStatus =
  'PENDING' | 'TRANSFER_REPORTED' | 'CONFIRMED' | 'WAIVED' | 'CANCELLED' | 'REVERSED';

type ExpectedVersions = Readonly<{ expectedVersion: number; expectedFinanceVersion: number }>;
export type ManualContributionCommand = ExpectedVersions &
  (
    | Readonly<{ action: 'REPORT_TRANSFER' }>
    | Readonly<{ action: 'CONFIRM_RECEIVED' }>
    | Readonly<{ action: 'REJECT_TRANSFER'; reason: string }>
  );

/** Trusted stored state read under the same Fund/contribution lock. */
export type ContributionTransitionContext = ContributionPermissionContext &
  Readonly<{
    status: ContributionStatus;
    amount: bigint;
    version: number;
    fundStatus: 'OPEN' | 'CLOSING' | 'CLOSED';
    financeVersion: number;
    currentBalance: bigint;
    hasOriginalReceipt: boolean;
  }>;

/** Decision only, not a persisted Contribution or a successful payment response. */
export type ManualContributionEffect = Readonly<{
  nextStatus: 'PENDING' | 'TRANSFER_REPORTED' | 'CONFIRMED';
  selfContribution: boolean;
  rejectionReason: string | null;
  ledgerEntry: Readonly<{ direction: 'IN'; amount: bigint; balanceAfter: bigint }> | null;
}>;

export class ContributionStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContributionStateConflictError';
  }
}

export class ContributionVersionConflictError extends Error {
  constructor() {
    super('Contribution or Fund version has changed');
    this.name = 'ContributionVersionConflictError';
  }
}

function assertVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw new RangeError('Version must be a positive PostgreSQL integer');
  }
}

/**
 * API087–089 / AC-FN03: plan a NEW manual command without mutating the context.
 * Caller authenticates actor, validates UUIDs/evidence ownership, obtains the Trip guard,
 * and resolves immutable receipt replay before planning a new transition. Context and
 * receipt existence come from stored state, never client-supplied roles or flags.
 * Persist state/timestamps/versions, audit, command receipt, outbox and any ledger/balance
 * together under locks and unique source keys. This pure check cannot prevent races or
 * reconcile provider outcomes; manual confirmation assumes the Holder verified the full
 * stored amount/destination. No partial amount, provider callback or idempotent replay here.
 * A rejection must retain prior report/evidence history; this effect is not a row patch.
 */
export function planManualContributionTransition(
  command: ManualContributionCommand,
  context: ContributionTransitionContext,
): ManualContributionEffect {
  if (!['REPORT_TRANSFER', 'CONFIRM_RECEIVED', 'REJECT_TRANSFER'].includes(command.action)) {
    throw new TypeError('Unknown manual contribution action');
  }
  assertContributionActionAllowed(command.action, context);
  if (context.fundStatus !== 'OPEN') {
    throw new ContributionStateConflictError('Manual contribution changes require an OPEN Fund');
  }
  for (const value of [
    context.version,
    context.financeVersion,
    command.expectedVersion,
    command.expectedFinanceVersion,
  ]) {
    assertVersion(value);
  }
  if (
    context.version !== command.expectedVersion ||
    context.financeVersion !== command.expectedFinanceVersion
  ) {
    throw new ContributionVersionConflictError();
  }
  const requiredStatus = command.action === 'REPORT_TRANSFER' ? 'PENDING' : 'TRANSFER_REPORTED';
  if (context.status !== requiredStatus) {
    throw new ContributionStateConflictError(`This action requires ${requiredStatus}`);
  }
  if (typeof context.hasOriginalReceipt !== 'boolean') {
    throw new TypeError('Stored receipt existence must be a boolean');
  }
  if (context.hasOriginalReceipt) {
    throw new ContributionStateConflictError('The contribution already has an original receipt');
  }
  assertVndAmount(context.amount);
  if (context.amount === 0n) throw new RangeError('Contribution amount must be greater than zero');
  assertVndAmount(context.currentBalance);
  const selfContribution = context.memberUserId === context.holderUserId;

  switch (command.action) {
    case 'REPORT_TRANSFER':
      return {
        nextStatus: 'TRANSFER_REPORTED',
        selfContribution,
        rejectionReason: null,
        ledgerEntry: null,
      };
    case 'CONFIRM_RECEIVED':
      return {
        nextStatus: 'CONFIRMED',
        selfContribution,
        rejectionReason: null,
        ledgerEntry: {
          direction: 'IN',
          amount: context.amount,
          balanceAfter: calculateBalanceAfterEntry(context.currentBalance, 'IN', context.amount),
        },
      };
    case 'REJECT_TRANSFER': {
      if (typeof command.reason !== 'string' || command.reason.trim().length === 0) {
        throw new TypeError('A transfer rejection requires a reason');
      }
      return {
        nextStatus: 'PENDING',
        selfContribution,
        rejectionReason: command.reason.trim(),
        ledgerEntry: null,
      };
    }
  }
}
