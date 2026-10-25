import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ContributionQueryService } from './contribution-query.service';
import { FundQueryService } from './fund-query.service';
import { CommonV1 } from '@wolfari/contracts/grpc';
const id = '10000000-0000-4000-8000-000000000001';
const input = { fund_id: id, actor_user_id: id };
function setup() {
  const trip = {
    getAccessContext: vi.fn().mockResolvedValue({
      context: {
        trip_id: id,
        allowed: true,
        can_read_trip: true,
        trip_state: CommonV1.TripState.TRIP_STATE_ACTIVE,
        membership: {
          trip_id: id,
          user_id: id,
          role: CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
        },
      },
    }),
  };
  const funds = {
    findScopeById: vi.fn().mockResolvedValue({ tripId: id }),
    findSummaryByTripId: vi.fn(),
  };
  const auth = new FundQueryService(funds, { listByFund: vi.fn() }, trip);
  const rows = { list: vi.fn().mockResolvedValue({ financeVersion: 9, items: [] }) };
  return { trip, funds, rows, service: new ContributionQueryService(auth, rows) };
}
describe('Contribution read authorization', () => {
  it.each(['listRequests', 'listContributions'] as const)(
    '%s checks current membership on each page before SQL',
    async (method) => {
      const s = setup();
      expect(await s.service[method](input, id, Date.now() + 5000)).toEqual({
        items: [],
        next_cursor: undefined,
      });
      expect(s.trip.getAccessContext).toHaveBeenCalledWith(
        { trip_id: id, user_id: id, action: 'TRIP_VIEW' },
        id,
        expect.any(Number),
      );
      s.trip.getAccessContext.mockRejectedValue({
        details: JSON.stringify({ code: 'PERMISSION_DENIED' }),
      });
      await expect(s.service[method](input, id, Date.now() + 5000)).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
      expect(s.rows.list).toHaveBeenCalledTimes(1);
    },
  );
  it('does not read list when Fund is absent, input is invalid or authority is unavailable', async () => {
    const s = setup();
    await expect(
      s.service.listRequests({ ...input, limit: 0 }, id, Date.now() + 5000),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(s.trip.getAccessContext).not.toHaveBeenCalled();
    s.funds.findScopeById.mockResolvedValueOnce(undefined);
    await expect(s.service.listRequests(input, id, Date.now() + 5000)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    s.trip.getAccessContext.mockRejectedValue(new Error('Transport failed'));
    await expect(s.service.listRequests(input, id, Date.now() + 5000)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(s.rows.list).not.toHaveBeenCalled();
  });
});
