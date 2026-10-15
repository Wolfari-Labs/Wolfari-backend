import { describe, expect, it } from 'vitest';
import { ContributionPermissionDeniedError } from './contribution-permissions';
import {
  ContributionStateConflictError,
  ContributionVersionConflictError,
  planManualContributionTransition,
  type ContributionTransitionContext,
  type ManualContributionCommand,
} from './contribution-transition';

const member = '10000000-0000-4000-8000-000000000001';
const holder = '10000000-0000-4000-8000-000000000002';
const owner = '10000000-0000-4000-8000-000000000003';
const context = (): ContributionTransitionContext => ({
  actorUserId: member,
  memberUserId: member,
  holderUserId: holder,
  activeMemberUserIds: new Set([member, holder, owner]),
  status: 'PENDING',
  amount: 100_000n,
  version: 3,
  fundStatus: 'OPEN',
  financeVersion: 7,
  currentBalance: 200_000n,
  hasOriginalReceipt: false,
});
const report: ManualContributionCommand = {
  action: 'REPORT_TRANSFER',
  expectedVersion: 3,
  expectedFinanceVersion: 7,
};
const confirm: ManualContributionCommand = {
  action: 'CONFIRM_RECEIVED',
  expectedVersion: 3,
  expectedFinanceVersion: 7,
};
const reject: ManualContributionCommand = {
  action: 'REJECT_TRANSFER',
  reason: '  Not received  ',
  expectedVersion: 3,
  expectedFinanceVersion: 7,
};
const reported = (): ContributionTransitionContext => ({
  ...context(),
  actorUserId: holder,
  status: 'TRANSFER_REPORTED',
});
const scenarios = [
  { command: report, state: context },
  { command: confirm, state: reported },
  { command: reject, state: reported },
];

describe('manual contribution transitions', () => {
  it('reports a transfer without creating a receipt or increasing balance', () => {
    expect(planManualContributionTransition(report, context())).toEqual({
      nextStatus: 'TRANSFER_REPORTED',
      selfContribution: false,
      rejectionReason: null,
      ledgerEntry: null,
    });
  });

  it('allows only Holder confirmation of a report to plan the full IN amount', () => {
    expect(planManualContributionTransition(confirm, reported())).toEqual({
      nextStatus: 'CONFIRMED',
      selfContribution: false,
      rejectionReason: null,
      ledgerEntry: { direction: 'IN', amount: 100_000n, balanceAfter: 300_000n },
    });
  });

  it('returns a rejected report to PENDING with a reason and no ledger effect', () => {
    expect(planManualContributionTransition(reject, reported())).toEqual({
      nextStatus: 'PENDING',
      selfContribution: false,
      rejectionReason: 'Not received',
      ledgerEntry: null,
    });
  });

  it('supports report -> reject -> report -> confirm using updated stored versions', () => {
    let state = context();
    for (const command of [report, reject, report, confirm]) {
      const effect = planManualContributionTransition(
        {
          ...command,
          expectedVersion: state.version,
          expectedFinanceVersion: state.financeVersion,
        },
        { ...state, actorUserId: command.action === 'REPORT_TRANSFER' ? member : holder },
      );
      state = {
        ...state,
        status: effect.nextStatus,
        version: state.version + 1,
        financeVersion: state.financeVersion + 1,
        currentBalance: effect.ledgerEntry?.balanceAfter ?? state.currentBalance,
        hasOriginalReceipt: effect.ledgerEntry !== null,
      };
    }
    expect(state.status).toBe('CONFIRMED');
    expect(state.currentBalance).toBe(300_000n);
  });

  it('marks self-contribution on both report and confirmation when Holder contributes', () => {
    for (const { command, state } of scenarios) {
      expect(
        planManualContributionTransition(command, {
          ...state(),
          actorUserId: holder,
          memberUserId: holder,
        }).selfContribution,
      ).toBe(true);
    }
  });

  it('keeps one-dong precision above Number.MAX_SAFE_INTEGER', () => {
    expect(
      planManualContributionTransition(confirm, {
        ...reported(),
        amount: 1n,
        currentBalance: 9007199254740993n,
      }).ledgerEntry?.balanceAfter,
    ).toBe(9007199254740994n);
  });

  it('rejects confirmation that would overflow int8 but permits a report without credit', () => {
    expect(() =>
      planManualContributionTransition(confirm, {
        ...reported(),
        currentBalance: 9223372036854775807n,
      }),
    ).toThrow(RangeError);
    expect(
      planManualContributionTransition(report, {
        ...context(),
        currentBalance: 9223372036854775807n,
      }).ledgerEntry,
    ).toBeNull();
  });

  it.each(['CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'] as const)(
    'rejects new manual commands for terminal %s',
    (status) => {
      for (const { command, state } of scenarios) {
        expect(() => planManualContributionTransition(command, { ...state(), status })).toThrow(
          ContributionStateConflictError,
        );
      }
    },
  );

  it('rejects confirmation/rejection before a report and a second new report', () => {
    for (const command of [confirm, reject]) {
      expect(() =>
        planManualContributionTransition(command, { ...reported(), status: 'PENDING' }),
      ).toThrow(ContributionStateConflictError);
    }
    expect(() =>
      planManualContributionTransition(report, { ...context(), status: 'TRANSFER_REPORTED' }),
    ).toThrow(ContributionStateConflictError);
  });

  it.each(['CLOSING', 'CLOSED'] as const)(
    'rejects all manual writes when Fund is %s',
    (fundStatus) => {
      for (const { command, state } of scenarios) {
        expect(() => planManualContributionTransition(command, { ...state(), fundStatus })).toThrow(
          ContributionStateConflictError,
        );
      }
    },
  );

  it.each(scenarios)('enforces existing actor rules for $command.action', ({ command, state }) => {
    expect(() =>
      planManualContributionTransition(command, { ...state(), actorUserId: owner }),
    ).toThrow(ContributionPermissionDeniedError);
    expect(() =>
      planManualContributionTransition(command, { ...state(), activeMemberUserIds: new Set() }),
    ).toThrow(ContributionPermissionDeniedError);
  });

  it.each(['expectedVersion', 'expectedFinanceVersion'] as const)(
    'rejects stale $0 before planning a transition',
    (field) => {
      expect(() =>
        planManualContributionTransition({ ...confirm, [field]: 1 }, reported()),
      ).toThrow(ContributionVersionConflictError);
    },
  );

  it.each([0, -1, 1.5, 2147483648, NaN])('rejects invalid version %s', (version) => {
    expect(() =>
      planManualContributionTransition({ ...report, expectedVersion: version }, context()),
    ).toThrow(RangeError);
    expect(() =>
      planManualContributionTransition(report, { ...context(), financeVersion: version }),
    ).toThrow(RangeError);
  });

  it.each(['', ' \n ', null])('requires a rejection reason: %s', (reason) => {
    expect(() =>
      planManualContributionTransition(
        { ...reject, reason } as ManualContributionCommand,
        reported(),
      ),
    ).toThrow(TypeError);
  });

  it('rejects a new transition if an original receipt already exists even with stale source status', () => {
    for (const { command, state } of scenarios) {
      expect(() =>
        planManualContributionTransition(command, { ...state(), hasOriginalReceipt: true }),
      ).toThrow(ContributionStateConflictError);
    }
  });

  it('requires explicit stored receipt existence instead of trusting a missing flag', () => {
    expect(() =>
      planManualContributionTransition(confirm, {
        ...reported(),
        hasOriginalReceipt: undefined,
      } as unknown as ContributionTransitionContext),
    ).toThrow(TypeError);
  });

  it.each([0n, -1n, 9223372036854775808n])(
    'rejects invalid stored contribution amount %s',
    (amount) => {
      expect(() => planManualContributionTransition(confirm, { ...reported(), amount })).toThrow(
        RangeError,
      );
    },
  );

  it('does not accept a read/payment action as a manual mutation', () => {
    expect(() =>
      planManualContributionTransition(
        { ...report, action: 'VIEW_PAYMENT_INSTRUCTION' } as unknown as ManualContributionCommand,
        context(),
      ),
    ).toThrow(TypeError);
  });

  it('does not mutate stored state, membership, report evidence or command', () => {
    const state = Object.freeze({
      ...reported(),
      memberReportedAt: '2026-09-30T01:00:00Z',
      evidence: 'private/object',
    });
    const before = structuredClone(state);
    const command = Object.freeze({ ...reject });
    planManualContributionTransition(command, state);
    expect(state).toEqual(before);
    expect(command.reason).toBe('  Not received  ');
  });
});
