import { describe, expect, it } from 'vitest';
import {
  assertValidContributionRequest,
  InvalidContributionRequestError,
  type ContributionDestination,
  type ContributionRequestContext,
  type ContributionRequestItem,
} from './contribution-request';

const fundId = '00000000-0000-4000-8000-000000000001';
const memberA = '00000000-0000-4000-8000-000000000002';
const memberB = '00000000-0000-4000-8000-000000000003';
const destination: ContributionDestination = {
  id: '00000000-0000-4000-8000-000000000004',
  fundId,
  active: true,
  confirmedByHolderAt: '2026-09-23T10:00:00Z',
};
const context: ContributionRequestContext = {
  fundId,
  activeMemberUserIds: new Set([memberA, memberB]),
  destinations: [destination],
};
const item: ContributionRequestItem = {
  memberUserId: memberA,
  amount: 200_000n,
  destinationId: destination.id,
};

describe('new contribution request allocations', () => {
  it('accepts different positive amounts for active members using the same destination', () => {
    expect(() =>
      assertValidContributionRequest(
        [item, { ...item, memberUserId: memberB, amount: 1n }],
        context,
      ),
    ).not.toThrow();
  });

  it('allows a request for a subset of the active members', () => {
    expect(() => assertValidContributionRequest([item], context)).not.toThrow();
  });

  it('accepts independently selected eligible destinations', () => {
    const secondDestination = {
      ...destination,
      id: '00000000-0000-4000-8000-000000000005',
    };
    expect(() =>
      assertValidContributionRequest(
        [item, { ...item, memberUserId: memberB, destinationId: secondDestination.id }],
        { ...context, destinations: [destination, secondDestination] },
      ),
    ).not.toThrow();
  });

  it('rejects an empty allocation list', () => {
    expect(() => assertValidContributionRequest([], context)).toThrow(
      InvalidContributionRequestError,
    );
  });

  it('rejects duplicate members even when their amounts differ', () => {
    expect(() =>
      assertValidContributionRequest([item, { ...item, amount: 300_000n }], context),
    ).toThrow(InvalidContributionRequestError);
  });

  it('rejects a member who is absent from the current active membership snapshot', () => {
    expect(() =>
      assertValidContributionRequest([item], {
        ...context,
        activeMemberUserIds: new Set([memberB]),
      }),
    ).toThrow(InvalidContributionRequestError);
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])('rejects contribution amount %s', (amount) => {
    expect(() => assertValidContributionRequest([{ ...item, amount }], context)).toThrow(
      RangeError,
    );
  });

  it('rejects Number amounts instead of silently coercing money', () => {
    expect(() =>
      assertValidContributionRequest([{ ...item, amount: 200_000 as unknown as bigint }], context),
    ).toThrow(TypeError);
  });

  it('accepts the bigint maximum for each contribution without imposing a combined balance limit', () => {
    // Requests are obligations, not receipts; they do not credit the Fund immediately.
    const amount = 9_223_372_036_854_775_807n;
    expect(() =>
      assertValidContributionRequest(
        [
          { ...item, amount },
          { ...item, memberUserId: memberB, amount },
        ],
        context,
      ),
    ).not.toThrow();
  });

  it('rejects a destination absent from stored data', () => {
    expect(() => assertValidContributionRequest([item], { ...context, destinations: [] })).toThrow(
      InvalidContributionRequestError,
    );
  });

  it.each([
    { label: 'another Fund', patch: { fundId: '00000000-0000-4000-8000-000000000006' } },
    { label: 'inactive', patch: { active: false } },
    { label: 'not confirmed by the Holder', patch: { confirmedByHolderAt: null } },
  ])('rejects a destination that is $label', ({ patch }) => {
    expect(() =>
      assertValidContributionRequest([item], {
        ...context,
        destinations: [{ ...destination, ...patch }],
      }),
    ).toThrow(InvalidContributionRequestError);
  });

  it('rechecks confirmation when destination details have changed', () => {
    assertValidContributionRequest([item], context);
    const changedContext = {
      ...context,
      destinations: [{ ...destination, confirmedByHolderAt: null }],
    };
    expect(() => assertValidContributionRequest([item], changedContext)).toThrow(
      InvalidContributionRequestError,
    );
  });

  it('does not modify allocations or context when a later allocation fails', () => {
    const items = Object.freeze([
      Object.freeze({ ...item }),
      Object.freeze({ ...item, memberUserId: memberB, amount: 0n }),
    ]);
    const frozenContext = Object.freeze({
      ...context,
      activeMemberUserIds: new Set([memberA, memberB]),
      destinations: Object.freeze([Object.freeze({ ...destination })]),
    });
    expect(() => assertValidContributionRequest(items, frozenContext)).toThrow(RangeError);
    expect(items).toEqual([item, { ...item, memberUserId: memberB, amount: 0n }]);
    expect(frozenContext).toEqual(context);
  });
});
