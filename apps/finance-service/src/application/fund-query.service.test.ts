import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CommonV1, type TripV1 } from '@wolfari/contracts/grpc';
import { FundQueryService } from './fund-query.service';
import type { FundSummary } from '../repositories/fund.repository';
import { PaymentDestinationQueryRepository } from '../repositories/payment-destination-query.repository';
import { FundRepository } from '../repositories/fund.repository';
import { destinationResponse } from '../projections/fund-response';
import { LedgerCursorInputError, LedgerLimitInputError } from '../repositories/ledger.repository';

const tripId = '10000000-0000-4000-8000-000000000001',
  fundId = '20000000-0000-4000-8000-000000000001';
const actor = '30000000-0000-4000-8000-000000000001',
  holder = '30000000-0000-4000-8000-000000000002';
const row = {
  id: fundId,
  fund_id: fundId,
  destination_type: 'VIETQR' as const,
  is_default: false,
  active: true,
  version: 2,
  confirmed_by_holder_at: null,
  bank_code: 'TEST',
  account_number: '00123',
  account_name: 'PRIVATE',
  momo_phone: 'DO NOT EXPOSE',
};
const fund: FundSummary = {
  id: fundId,
  tripId,
  holderUserId: holder,
  currency: 'VND',
  budgetAmount: null,
  currentBalance: 9007199254740993n,
  reservedRefund: 9007199254740992n,
  availableBalance: 1n,
  status: 'OPEN',
  financeVersion: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
  closedAt: null,
};
function setup(role = CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER) {
  const context = {
    trip_id: tripId,
    allowed: true,
    can_read_trip: true,
    trip_state: CommonV1.TripState.TRIP_STATE_ACTIVE,
    membership: { id: actor, trip_id: tripId, user_id: actor, role, left_at: undefined },
  } as NonNullable<TripV1.GetAccessContextResponse['context']>;
  const funds = {
    findScopeById: vi.fn().mockResolvedValue({ tripId, holderUserId: holder }),
    findSummaryByTripId: vi.fn().mockResolvedValue(fund),
  };
  const destinations = { listByFund: vi.fn().mockResolvedValue([row]) };
  const trip = { getAccessContext: vi.fn().mockResolvedValue({ context }) };
  const ledger = { listByFundId: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };
  return {
    context,
    funds,
    destinations,
    trip,
    ledger,
    service: new FundQueryService(funds, destinations, trip, ledger),
  };
}
const deadline = () => Date.now() + 5000;
const input = { fund_id: fundId, actor_user_id: actor };

describe('Finance API read authorization and projection', () => {
  it('checks current access on every ledger page and distinguishes absent Fund from empty ledger', async () => {
    const s = setup();
    expect(await s.service.listFundTransactions(input, actor, deadline())).toEqual({
      items: [],
      next_cursor: undefined,
    });
    expect(s.trip.getAccessContext.mock.invocationCallOrder[0]).toBeLessThan(
      s.ledger.listByFundId.mock.invocationCallOrder[0]!,
    );
    s.context.membership!.left_at = { seconds: '1', nanos: 0 };
    await expect(s.service.listFundTransactions(input, actor, deadline())).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(s.ledger.listByFundId).toHaveBeenCalledTimes(1);
    s.funds.findScopeById.mockResolvedValue(null);
    await expect(s.service.listFundTransactions(input, actor, deadline())).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(s.ledger.listByFundId).toHaveBeenCalledTimes(1);
  });
  it.each([new LedgerCursorInputError(), new LedgerLimitInputError()])(
    'maps only explicit pagination errors to client validation',
    async (error) => {
      const s = setup();
      s.ledger.listByFundId.mockRejectedValue(error);
      await expect(s.service.listFundTransactions(input, actor, deadline())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    },
  );
  it.each([new TypeError('stored value'), new RangeError('stored amount'), new Error('database')])(
    'does not misclassify internal failure %s',
    async (error) => {
      const s = setup();
      s.ledger.listByFundId.mockRejectedValue(error);
      await expect(s.service.listFundTransactions(input, actor, deadline())).rejects.toBe(error);
    },
  );
  it('authorizes before reading Fund and returns exact money, nullable budget, no internal timestamps', async () => {
    const s = setup();
    const result = await s.service.getFund(
      { trip_id: tripId, actor_user_id: actor },
      actor,
      deadline(),
    );
    expect(s.trip.getAccessContext).toHaveBeenCalledWith(
      { trip_id: tripId, user_id: actor, action: 'TRIP_VIEW' },
      actor,
      expect.any(Number),
    );
    expect(s.trip.getAccessContext.mock.invocationCallOrder[0]).toBeLessThan(
      s.funds.findSummaryByTripId.mock.invocationCallOrder[0]!,
    );
    expect(result.fund).toMatchObject({
      budget_amount: undefined,
      current_balance: '9007199254740993',
      reserved_refund: '9007199254740992',
      available_balance: '1',
    });
    expect(result.fund).not.toHaveProperty('created_at');
  });
  it.each([0n, 9223372036854775807n])('preserves budget %s', async (budgetAmount) => {
    const s = setup();
    s.funds.findSummaryByTripId.mockResolvedValue({ ...fund, budgetAmount });
    expect(
      (await s.service.getFund({ trip_id: tripId, actor_user_id: actor }, actor, deadline())).fund
        .budget_amount,
    ).toBe(budgetAmount.toString());
  });
  it.each(['owner', 'holder', 'member'])(
    'projects details according to current %s authority',
    async (who) => {
      const s = setup(
        who === 'owner'
          ? CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER
          : CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
      );
      if (who === 'holder')
        s.funds.findScopeById.mockResolvedValue({ tripId, holderUserId: actor });
      const result = await s.service.listPaymentDestinations(input, actor, deadline());
      expect(s.destinations.listByFund).toHaveBeenCalledWith(fundId, who !== 'member');
      expect(JSON.stringify(result)).not.toContain('DO NOT EXPOSE');
      if (who === 'member') {
        expect(result.destinations[0]).not.toHaveProperty('account_number');
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
      } else expect(result.destinations[0]).toHaveProperty('account_number', '00123');
    },
  );
  it('allows archived Trips and CLOSED Funds to remain readable for current members', async () => {
    const s = setup();
    s.context.trip_state = CommonV1.TripState.TRIP_STATE_ARCHIVED;
    s.funds.findSummaryByTripId.mockResolvedValue({
      ...fund,
      status: 'CLOSED',
      closedAt: new Date('2026-10-14T00:00:00Z'),
    });
    expect(
      (await s.service.getFund({ trip_id: tripId, actor_user_id: actor }, actor, deadline())).fund
        .status,
    ).toBe(3);
  });
  it.each([
    'allowed',
    'can_read_trip',
    'left_at',
    'wrong_actor',
    'wrong_trip',
    'wrong_role',
    'deleted',
  ])('rejects access context %s before reading destinations', async (condition) => {
    const s = setup();
    if (condition === 'allowed') s.context.allowed = false;
    if (condition === 'can_read_trip') s.context.can_read_trip = false;
    if (condition === 'left_at') s.context.membership!.left_at = { seconds: '1', nanos: 0 };
    if (condition === 'wrong_actor') s.context.membership!.user_id = holder;
    if (condition === 'wrong_trip') s.context.trip_id = fundId;
    if (condition === 'wrong_role')
      s.context.membership!.role = CommonV1.MembershipRole.MEMBERSHIP_ROLE_UNSPECIFIED;
    if (condition === 'deleted') s.context.trip_state = CommonV1.TripState.TRIP_STATE_DELETED;
    await expect(s.service.listPaymentDestinations(input, actor, deadline())).rejects.toThrow();
    expect(s.destinations.listByFund).not.toHaveBeenCalled();
  });
  it.each([
    [{ details: JSON.stringify({ code: 'RESOURCE_NOT_FOUND' }) }, 'RESOURCE_NOT_FOUND'],
    [{ details: JSON.stringify({ code: 'PERMISSION_DENIED' }) }, 'RESOURCE_NOT_FOUND'],
    [{ code: 7, details: 'Caller is not authorized' }, 'SERVICE_UNAVAILABLE'],
    [{ code: 4 }, 'SERVICE_UNAVAILABLE'],
  ])('maps user denial separately from downstream failure %j', async (error, code) => {
    const s = setup();
    s.trip.getAccessContext.mockRejectedValue(error);
    await expect(
      s.service.getFund({ trip_id: tripId, actor_user_id: actor }, actor, deadline()),
    ).rejects.toThrow(String(code));
    expect(s.funds.findSummaryByTripId).not.toHaveBeenCalled();
  });
  it('rejects malformed IDs before querying and expired deadlines before RPC', async () => {
    const s = setup();
    await expect(
      s.service.listPaymentDestinations({ ...input, fund_id: 'invalid' }, actor, deadline()),
    ).rejects.toThrow('VALIDATION_FAILED');
    expect(s.funds.findScopeById).not.toHaveBeenCalled();
    await expect(
      s.service.getFund({ trip_id: tripId, actor_user_id: actor }, actor, 0),
    ).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(s.trip.getAccessContext).not.toHaveBeenCalled();
  });
  it('does not cache authorization across requests', async () => {
    const s = setup();
    await s.service.listPaymentDestinations(input, actor, deadline());
    s.trip.getAccessContext.mockRejectedValue({ details: '{"code":"RESOURCE_NOT_FOUND"}' });
    await expect(s.service.listPaymentDestinations(input, actor, deadline())).rejects.toThrow(
      'RESOURCE_NOT_FOUND',
    );
    expect(s.destinations.listByFund).toHaveBeenCalledTimes(1);
  });
  it('distinguishes missing Fund from empty destination list and rejects wrong-Fund rows', async () => {
    const s = setup();
    s.destinations.listByFund.mockResolvedValue([]);
    expect(await s.service.listPaymentDestinations(input, actor, deadline())).toEqual({
      destinations: [],
    });
    s.destinations.listByFund.mockResolvedValue([{ ...row, fund_id: tripId }]);
    await expect(s.service.listPaymentDestinations(input, actor, deadline())).rejects.toThrow(
      'scope',
    );
    s.funds.findScopeById.mockResolvedValue(null);
    await expect(s.service.listPaymentDestinations(input, actor, deadline())).rejects.toThrow(
      'RESOURCE_NOT_FOUND',
    );
    s.funds.findSummaryByTripId.mockResolvedValue(null);
    await expect(
      s.service.getFund({ trip_id: tripId, actor_user_id: actor }, actor, deadline()),
    ).rejects.toThrow('RESOURCE_NOT_FOUND');
  });
  it('whitelists MOMO fields and refuses incomplete private details', () => {
    expect(
      destinationResponse({ ...row, destination_type: 'MOMO_SANDBOX', momo_phone: '00111' }, true),
    ).toMatchObject({ momo_phone: '00111' });
    expect(
      destinationResponse({ ...row, destination_type: 'MOMO_SANDBOX' }, true),
    ).not.toHaveProperty('account_number');
    expect(() => destinationResponse({ ...row, account_number: null }, true)).toThrow();
  });
});

describe('read repository scoping', () => {
  it('routes Fund ID with a parameter and does not return private data', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ trip_id: tripId, holder_user_id: holder }] });
    expect(await new FundRepository({ query }).findScopeById(fundId)).toEqual({
      tripId,
      holderUserId: holder,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [fundId]);
  });
  it.each([true, false])(
    'queries only permitted columns (private=%s), ordered and scoped',
    async (privateAccess) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      expect(
        await new PaymentDestinationQueryRepository({ query }).listByFund(fundId, privateAccess),
      ).toEqual([]);
      const [sql, params] = query.mock.calls[0]!;
      expect(sql).toContain('WHERE fund_id = $1 ORDER BY id');
      expect(params).toEqual([fundId]);
      if (privateAccess) expect(sql).toContain('account_number');
      else expect(sql).not.toContain('account_number');
    },
  );
});
