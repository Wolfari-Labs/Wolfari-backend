export type PaymentAuthority = Readonly<{
  actorUserId: string;
  memberUserId: string;
  holderUserId: string;
  activeMemberUserIds: ReadonlySet<string>;
  fundStatus: 'OPEN' | 'CLOSING' | 'CLOSED';
  requestStatus: string;
  contributionStatus: string;
  contributionVersion: number;
  financeVersion: number;
}>;

export class PaymentRuleError extends Error {
  constructor(
    public readonly code:
      'VALIDATION_FAILED' | 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT',
  ) {
    super(code);
  }
}

export function assertCanCreatePaymentAttempt(
  input: { expectedVersion: number; expectedFinanceVersion: number },
  context: PaymentAuthority,
) {
  if (
    context.actorUserId !== context.memberUserId ||
    !context.activeMemberUserIds.has(context.actorUserId)
  )
    throw new PaymentRuleError('PERMISSION_DENIED');
  if (
    input.expectedVersion !== context.contributionVersion ||
    input.expectedFinanceVersion !== context.financeVersion
  )
    throw new PaymentRuleError('VERSION_CONFLICT');
  if (
    context.fundStatus !== 'OPEN' ||
    context.requestStatus !== 'OPEN' ||
    context.contributionStatus !== 'PENDING'
  )
    throw new PaymentRuleError('STATE_CONFLICT');
}

export function assertHolderPaymentAction(
  actor: string,
  holder: string,
  active: ReadonlySet<string>,
  fundStatus: string,
) {
  if (actor !== holder || !active.has(actor)) throw new PaymentRuleError('PERMISSION_DENIED');
  if (fundStatus !== 'OPEN') throw new PaymentRuleError('STATE_CONFLICT');
}

export function classifyMomoResult(resultCode: number): 'SUCCEEDED' | 'PENDING' | 'FAILED' {
  if (resultCode === 0) return 'SUCCEEDED';
  // 9000 is authorization, not proof of captured funds for this project.
  if (resultCode === 9000 || resultCode === 1000 || resultCode === 7000) return 'PENDING';
  return 'FAILED';
}
