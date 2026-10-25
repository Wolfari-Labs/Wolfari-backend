const int32Max = 2_147_483_647;

export type MembershipLifecycleFacts = Readonly<{
  fundStatus: string;
  targetIsHolder: boolean;
  closurePending: boolean;
  hasTransferReported: boolean;
  hasBlockingPayment: boolean;
  hasBlockingRefund: boolean;
  hasInconsistentLedger: boolean;
  financeVersion: number;
  pendingContributionVersions: readonly number[];
}>;

export type MembershipLifecyclePlan = Readonly<{
  blocked: boolean;
  waivePending: boolean;
  financeVersion: number;
}>;

/**
 * Plans only from facts read under the Fund lock. A lifecycle command must inspect
 * every blocker before it waives any contribution, so callers can commit all
 * effects and the terminal receipt in one transaction.
 */
export function planMembershipLifecycle(facts: MembershipLifecycleFacts): MembershipLifecyclePlan {
  const knownFundStatus = ['OPEN', 'CLOSING', 'CLOSED'].includes(facts.fundStatus);
  const hasPending = facts.pendingContributionVersions.length > 0;
  const canAdvanceVersions =
    facts.financeVersion < int32Max &&
    facts.pendingContributionVersions.every(
      (version) => Number.isInteger(version) && version > 0 && version < int32Max,
    );
  const blocked =
    !knownFundStatus ||
    facts.fundStatus === 'CLOSING' ||
    facts.closurePending ||
    (facts.targetIsHolder && facts.fundStatus !== 'CLOSED') ||
    facts.hasTransferReported ||
    facts.hasBlockingPayment ||
    facts.hasBlockingRefund ||
    facts.hasInconsistentLedger ||
    (facts.fundStatus === 'CLOSED' && hasPending) ||
    (hasPending && !canAdvanceVersions);

  const waivePending = !blocked && facts.fundStatus === 'OPEN' && hasPending;
  return {
    blocked,
    waivePending,
    financeVersion: facts.financeVersion + Number(waivePending),
  };
}
