import { describe, expect, it } from 'vitest';
import { ContributionPermissionDeniedError } from './contribution-permissions';
import { InvalidContributionRequestError } from './contribution-request';
import {
  assertCanCreateContributionRequest,
  ContributionRequestCreationConflictError,
  type ContributionRequestCreationContext,
  type CreateContributionRequestCommand,
} from './contribution-request-creation';

const ownerId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';
const fundId = '00000000-0000-4000-8000-000000000003';
const destinationId = '00000000-0000-4000-8000-000000000004';
const command: CreateContributionRequestCommand = {
  title: 'Đóng quỹ chuyến đi',
  contributions: [{ memberUserId: memberId, amount: 200_000n, destinationId }],
  dueAt: null,
  note: null,
  expectedFinanceVersion: 3,
};
const context: ContributionRequestCreationContext = {
  fundId,
  actorUserId: ownerId,
  ownerUserId: ownerId,
  fundStatus: 'OPEN',
  financeVersion: 3,
  activeMemberUserIds: new Set([ownerId, memberId]),
  destinations: [
    { id: destinationId, fundId, active: true, confirmedByHolderAt: '2026-10-01T00:00:00Z' },
  ],
};

describe('creating a contribution request', () => {
  it('allows an active Owner to request a subset of members without contributing personally', () => {
    expect(() => assertCanCreateContributionRequest(command, context)).not.toThrow();
  });

  it('allows the Owner among recipients and unequal amounts whose total exceeds int8', () => {
    // Obligations do not credit the Fund; no combined balance limit at creation.
    expect(() =>
      assertCanCreateContributionRequest(
        {
          ...command,
          contributions: [
            command.contributions[0],
            { memberUserId: ownerId, amount: 9_223_372_036_854_775_807n, destinationId },
          ],
        },
        context,
      ),
    ).not.toThrow();
  });

  it('denies another active member, including a Holder who is not Owner', () => {
    expect(() =>
      assertCanCreateContributionRequest(command, { ...context, actorUserId: memberId }),
    ).toThrow(ContributionPermissionDeniedError);
  });

  it('denies an Owner missing from current active membership', () => {
    expect(() =>
      assertCanCreateContributionRequest(command, {
        ...context,
        activeMemberUserIds: new Set([memberId]),
      }),
    ).toThrow(ContributionPermissionDeniedError);
  });

  it.each(['CLOSING', 'CLOSED'] as const)('rejects a %s Fund', (fundStatus) => {
    expect(() => assertCanCreateContributionRequest(command, { ...context, fundStatus })).toThrow(
      new ContributionRequestCreationConflictError('FUND_NOT_OPEN'),
    );
  });

  it('rejects a stale Finance version', () => {
    expect(() =>
      assertCanCreateContributionRequest(command, { ...context, financeVersion: 4 }),
    ).toThrow(new ContributionRequestCreationConflictError('FINANCE_VERSION_CONFLICT'));
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, '3' as unknown as number])(
    'rejects invalid expected and stored version %s',
    (version) => {
      expect(() =>
        assertCanCreateContributionRequest(
          { ...command, expectedFinanceVersion: version },
          context,
        ),
      ).toThrow(RangeError);
      expect(() =>
        assertCanCreateContributionRequest(command, { ...context, financeVersion: version }),
      ).toThrow(RangeError);
    },
  );

  it.each([
    '',
    ' \t\n',
    'a'.repeat(201),
    '💰'.repeat(201),
    'Fund\u0000title',
    null as unknown as string,
  ])('rejects invalid title %#', (title) => {
    expect(() => assertCanCreateContributionRequest({ ...command, title }, context)).toThrow(
      InvalidContributionRequestError,
    );
  });

  it.each(['a'.repeat(200), '💰'.repeat(200), ' Đóng góp '])(
    'accepts a valid title %#',
    (title) => {
      expect(() =>
        assertCanCreateContributionRequest({ ...command, title }, context),
      ).not.toThrow();
    },
  );

  it.each([new Date('invalid'), '2026-10-02T00:00:00Z' as unknown as Date])(
    'rejects an invalid internal due date %#',
    (dueAt) => {
      expect(() => assertCanCreateContributionRequest({ ...command, dueAt }, context)).toThrow(
        InvalidContributionRequestError,
      );
    },
  );

  it('accepts a valid due date without inventing a future-only requirement', () => {
    expect(() =>
      assertCanCreateContributionRequest(
        { ...command, dueAt: new Date('2020-01-01T00:00:00Z'), note: '' },
        context,
      ),
    ).not.toThrow();
  });

  it.each(['note\u0000text', 1 as unknown as string])('rejects invalid note %#', (note) => {
    expect(() => assertCanCreateContributionRequest({ ...command, note }, context)).toThrow(
      InvalidContributionRequestError,
    );
  });

  it('still requires allocations and rejects duplicate recipients', () => {
    for (const contributions of [[], [command.contributions[0], command.contributions[0]]]) {
      expect(() =>
        assertCanCreateContributionRequest({ ...command, contributions }, context),
      ).toThrow(InvalidContributionRequestError);
    }
  });

  it('rechecks recipient membership and destination confirmation', () => {
    expect(() =>
      assertCanCreateContributionRequest(command, {
        ...context,
        activeMemberUserIds: new Set([ownerId]),
      }),
    ).toThrow(InvalidContributionRequestError);
    expect(() =>
      assertCanCreateContributionRequest(command, {
        ...context,
        destinations: [{ ...context.destinations[0], confirmedByHolderAt: null }],
      }),
    ).toThrow(InvalidContributionRequestError);
  });

  it('reuses positive exact-money validation', () => {
    for (const amount of [0n, -1n, 9_223_372_036_854_775_808n]) {
      expect(() =>
        assertCanCreateContributionRequest(
          { ...command, contributions: [{ ...command.contributions[0], amount }] },
          context,
        ),
      ).toThrow(RangeError);
    }
  });

  it('preserves metadata, allocations and context on success and failure', () => {
    const input = Object.freeze({
      ...command,
      title: ' Quỹ chuyến đi ',
      note: ' Giữ nguyên ghi chú ',
      dueAt: new Date('2026-10-05T01:02:03.000Z'),
      contributions: Object.freeze(command.contributions.map((item) => Object.freeze({ ...item }))),
    });
    const original = structuredClone(input);
    const stored = structuredClone(context);
    assertCanCreateContributionRequest(input, context);
    expect(() =>
      assertCanCreateContributionRequest({ ...input, expectedFinanceVersion: 2 }, context),
    ).toThrow(ContributionRequestCreationConflictError);
    expect(input).toEqual(original);
    expect(context).toEqual(stored);
  });
});
