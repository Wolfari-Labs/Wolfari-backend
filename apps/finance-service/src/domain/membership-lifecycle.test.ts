import { describe, expect, it } from 'vitest';
import { planMembershipLifecycle, type MembershipLifecycleFacts } from './membership-lifecycle';

const facts = (overrides: Partial<MembershipLifecycleFacts> = {}): MembershipLifecycleFacts => ({
  fundStatus: 'OPEN',
  targetIsHolder: false,
  closurePending: false,
  hasTransferReported: false,
  hasBlockingPayment: false,
  hasBlockingRefund: false,
  hasInconsistentLedger: false,
  financeVersion: 7,
  pendingContributionVersions: [],
  ...overrides,
});

describe('membership lifecycle finance rules', () => {
  it('allows a regular member without an unresolved obligation', () => {
    expect(planMembershipLifecycle(facts())).toEqual({
      blocked: false,
      waivePending: false,
      financeVersion: 7,
    });
  });

  it('waives every eligible pending contribution with one Fund version advance', () => {
    expect(planMembershipLifecycle(facts({ pendingContributionVersions: [1, 4, 9] }))).toEqual({
      blocked: false,
      waivePending: true,
      financeVersion: 8,
    });
  });

  it.each([
    { targetIsHolder: true },
    { fundStatus: 'CLOSING' },
    { closurePending: true },
    { hasTransferReported: true },
    { hasBlockingPayment: true },
    { hasBlockingRefund: true },
    { hasInconsistentLedger: true },
  ])('blocks an OPEN Fund for unresolved facts %j', (override) => {
    expect(planMembershipLifecycle(facts(override))).toMatchObject({
      blocked: true,
      waivePending: false,
      financeVersion: 7,
    });
  });

  it('allows the historical Holder only after the Fund is CLOSED and clean', () => {
    expect(
      planMembershipLifecycle(facts({ fundStatus: 'CLOSED', targetIsHolder: true })),
    ).toMatchObject({ blocked: false, waivePending: false });
  });

  it.each([
    { pendingContributionVersions: [1] },
    { hasBlockingRefund: true },
    { hasInconsistentLedger: true },
  ])('fails closed for inconsistent unresolved data on a CLOSED Fund %j', (override) => {
    expect(
      planMembershipLifecycle(facts({ fundStatus: 'CLOSED', targetIsHolder: true, ...override })),
    ).toMatchObject({ blocked: true, waivePending: false });
  });

  it.each([
    { financeVersion: 2_147_483_647, pendingContributionVersions: [1] },
    { pendingContributionVersions: [2_147_483_647] },
    { pendingContributionVersions: [0] },
  ])('blocks before a version overflow or corrupt version %j', (override) => {
    expect(planMembershipLifecycle(facts(override))).toMatchObject({
      blocked: true,
      waivePending: false,
    });
  });
});
