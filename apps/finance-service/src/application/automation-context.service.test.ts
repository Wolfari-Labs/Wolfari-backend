import 'reflect-metadata';
import { status } from '@grpc/grpc-js';
import { CommonV1, FinanceV1, type TripV1 } from '@wolfari/contracts/grpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationContextSnapshot } from '../repositories/automation-context.repository';
import { FinanceAutomationContextService } from './automation-context.service';

const fundId = '10000000-0000-4000-8000-000000000001';
const tripId = '20000000-0000-4000-8000-000000000001';
const sourceId = '30000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000001';
const otherUser = '40000000-0000-4000-8000-000000000002';
const correlation = '50000000-0000-4000-8000-000000000001';
const input = { fund_id: fundId, source_type: 'CONTRIBUTION_DUE', source_id: sourceId };
const deadline = () => Date.now() + 5000;
function snapshot(): AutomationContextSnapshot {
  return {
    fundId,
    tripId,
    financeVersion: 8,
    fundStatus: 'OPEN',
    sourceType: 'CONTRIBUTION_DUE',
    sourceId,
    sourceStatus: 'PENDING',
    sourceVersion: 2,
    requestStatus: 'OPEN',
    requestVersion: 1,
    dueAt: '2026-11-01T02:00:00.123Z',
    eligible: true,
    candidates: [{ userId, cutoffMicros: '1792886400123456' }],
  };
}
function access(user = userId): TripV1.GetAccessContextResponse {
  return {
    context: {
      trip_id: tripId,
      allowed: true,
      can_read_trip: true,
      trip_state: CommonV1.TripState.TRIP_STATE_ACTIVE,
      membership: {
        id: user,
        trip_id: tripId,
        user_id: user,
        role: CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
        joined_at: { seconds: '1792886400', nanos: 122000000 },
      },
      revisions: { plan_version: 1, membership_revision: 1, export_revision: 1 },
    },
  };
}
function setup() {
  const current = snapshot();
  const context = access();
  const repository = { find: vi.fn().mockImplementation(async () => structuredClone(current)) };
  const trip = { getAccessContext: vi.fn().mockResolvedValue(context) };
  const service = new FinanceAutomationContextService(repository, trip);
  return { current, context, repository, trip, service };
}
afterEach(() => vi.restoreAllMocks());

describe('Finance Automation current audience', () => {
  it('returns only the existing minimal response after current access and a matching reread', async () => {
    const s = setup();
    const until = deadline();
    expect(await s.service.get(input, correlation, until)).toEqual({
      finance_version: 8,
      status: FinanceV1.FundStatus.FUND_STATUS_OPEN,
      authorized_recipients: [{ user_id: userId }],
      due_at: { seconds: '1793498400', nanos: 123000000 },
    });
    expect(s.trip.getAccessContext).toHaveBeenCalledWith(
      { trip_id: tripId, user_id: userId, action: 'TRIP_VIEW' },
      correlation,
      until,
    );
    expect(s.repository.find).toHaveBeenNthCalledWith(
      1,
      fundId,
      'CONTRIBUTION_DUE',
      sourceId,
      until,
    );
    expect(s.repository.find).toHaveBeenNthCalledWith(
      2,
      fundId,
      'CONTRIBUTION_DUE',
      sourceId,
      until,
    );
    const order = s.repository.find.mock.invocationCallOrder;
    expect(order[0]).toBeLessThan(s.trip.getAccessContext.mock.invocationCallOrder[0]!);
    expect(order[1]).toBeGreaterThan(s.trip.getAccessContext.mock.invocationCallOrder[0]!);
  });

  it.each([
    { fund_id: 'invalid' },
    { source_id: 'invalid' },
    { source_type: 'contribution_due' },
    { source_type: 'CONTRIBUTION' },
    { source_type: undefined },
  ])('rejects invalid scope or ambiguous purpose %j before reading', async (patch) => {
    const s = setup();
    await expect(
      s.service.get({ ...input, ...patch }, correlation, deadline()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(s.repository.find).not.toHaveBeenCalled();
  });

  it('normalizes UUID inputs and distinguishes absent sources from empty eligible audiences', async () => {
    const s = setup();
    s.repository.find.mockResolvedValueOnce(null);
    await expect(
      s.service.get(
        { ...input, fund_id: fundId.toUpperCase(), source_id: sourceId.toUpperCase() },
        correlation,
        deadline(),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    s.current.candidates = [];
    expect(await s.service.get(input, correlation, deadline())).toMatchObject({
      authorized_recipients: [],
      due_at: undefined,
    });
    expect(s.trip.getAccessContext).not.toHaveBeenCalled();
  });

  it.each(['TRANSFER_REPORTED', 'CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'])(
    'does not redirect a stale debtor purpose after %s',
    async (sourceStatus) => {
      const s = setup();
      s.current.sourceStatus = sourceStatus;
      s.current.eligible = false;
      s.current.candidates = [];
      expect(await s.service.get(input, correlation, deadline())).toMatchObject({
        authorized_recipients: [],
        due_at: undefined,
      });
      expect(s.trip.getAccessContext).not.toHaveBeenCalled();
    },
  );

  it.each(['CONTRIBUTION_REVIEW', 'CLOSURE'] as const)(
    'never fabricates a deadline for %s',
    async (sourceType) => {
      const s = setup();
      s.current.sourceType = sourceType;
      expect(
        await s.service.get({ ...input, source_type: sourceType }, correlation, deadline()),
      ).toMatchObject({ authorized_recipients: [{ user_id: userId }], due_at: undefined });
    },
  );

  it.each([
    [status.NOT_FOUND, 'RESOURCE_NOT_FOUND'],
    [status.PERMISSION_DENIED, 'PERMISSION_DENIED'],
  ])(
    'excludes a trusted denial %s/%s without exposing an audience or deadline',
    async (code, domain) => {
      const s = setup();
      s.trip.getAccessContext.mockRejectedValue({
        code,
        details: JSON.stringify({ code: domain, details: null }),
      });
      expect(await s.service.get(input, correlation, deadline())).toMatchObject({
        authorized_recipients: [],
        due_at: undefined,
      });
      expect(s.repository.find).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { code: status.PERMISSION_DENIED, details: 'Caller is not authorized' },
    { code: status.UNAVAILABLE, details: JSON.stringify({ code: 'RESOURCE_NOT_FOUND' }) },
    { code: status.NOT_FOUND, details: JSON.stringify({ code: 'PERMISSION_DENIED' }) },
    { code: status.NOT_FOUND, details: 'malformed JSON' },
    new Error('transport failure'),
  ])(
    'does not turn an untrusted dependency error into successful partial recipients',
    async (failure) => {
      const s = setup();
      s.current.candidates.push({ userId: otherUser, cutoffMicros: '1792886400123456' });
      s.trip.getAccessContext.mockResolvedValueOnce(access()).mockRejectedValueOnce(failure);
      await expect(s.service.get(input, correlation, deadline())).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(s.repository.find).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['archived', 'left', 'denied', 'unreadable', 'rejoined'])(
    'suppresses a currently %s recipient',
    async (condition) => {
      const s = setup(),
        ctx = s.context.context!;
      if (condition === 'archived') ctx.trip_state = CommonV1.TripState.TRIP_STATE_ARCHIVED;
      if (condition === 'left') ctx.membership!.left_at = { seconds: '1792886401', nanos: 0 };
      if (condition === 'denied') ctx.allowed = false;
      if (condition === 'unreadable') ctx.can_read_trip = false;
      if (condition === 'rejoined')
        ctx.membership!.joined_at = { seconds: '1792886400', nanos: 123457000 };
      expect(await s.service.get(input, correlation, deadline())).toMatchObject({
        authorized_recipients: [],
        due_at: undefined,
      });
    },
  );

  it('excludes a historical candidate when Trip precision leaves a same-millisecond rejoin ambiguous', async () => {
    const s = setup();
    s.current.candidates[0]!.cutoffMicros = '1792886400000500';
    s.context.context!.membership!.joined_at = { seconds: '1792886400', nanos: 0 };
    expect((await s.service.get(input, correlation, deadline())).authorized_recipients).toEqual([]);
  });

  it('uses each debtor cutoff while a current Holder may join after the source', async () => {
    const s = setup();
    s.current.sourceType = 'CONTRIBUTION_REQUEST';
    s.current.candidates.push({ userId: otherUser, cutoffMicros: '1792886400121999' });
    s.trip.getAccessContext.mockImplementation(async (request) => access(request.user_id));
    expect(
      (
        await s.service.get(
          { ...input, source_type: 'CONTRIBUTION_REQUEST' },
          correlation,
          deadline(),
        )
      ).authorized_recipients,
    ).toEqual([{ user_id: userId }]);
    s.current.sourceType = 'CONTRIBUTION_REVIEW';
    s.current.candidates = [{ userId, cutoffMicros: null }];
    s.trip.getAccessContext.mockResolvedValue({
      context: {
        ...access().context,
        membership: {
          ...access().context!.membership,
          joined_at: { seconds: '1792886500', nanos: 0 },
        },
      },
    });
    expect(
      (
        await s.service.get(
          { ...input, source_type: 'CONTRIBUTION_REVIEW' },
          correlation,
          deadline(),
        )
      ).authorized_recipients,
    ).toEqual([{ user_id: userId }]);
  });

  it('excludes a rejoined required closure user without changing the stored required set', async () => {
    const s = setup();
    s.current.sourceType = 'CLOSURE';
    s.current.fundStatus = 'CLOSING';
    s.context.context!.membership!.joined_at = { seconds: '1792886401', nanos: 0 };
    const before = structuredClone(s.current);
    expect(
      (await s.service.get({ ...input, source_type: 'CLOSURE' }, correlation, deadline()))
        .authorized_recipients,
    ).toEqual([]);
    expect(s.current).toEqual(before);
  });

  it.each([
    'trip',
    'user',
    'membershipId',
    'role',
    'state',
    'allowed',
    'revisions',
    'joined',
    'left',
  ])('fails closed for malformed Trip %s', async (field) => {
    const s = setup(),
      ctx = s.context.context!;
    if (field === 'trip') ctx.trip_id = sourceId;
    if (field === 'user') ctx.membership!.user_id = otherUser;
    if (field === 'membershipId') ctx.membership!.id = 'invalid';
    if (field === 'role') ctx.membership!.role = 0;
    if (field === 'state') ctx.trip_state = 0;
    if (field === 'allowed') ctx.allowed = undefined;
    if (field === 'revisions') ctx.revisions = undefined;
    if (field === 'joined') ctx.membership!.joined_at = { seconds: 'Infinity', nanos: 0 };
    if (field === 'left') ctx.membership!.left_at = { seconds: '1', nanos: -1 };
    await expect(s.service.get(input, correlation, deadline())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it.each(['financeVersion', 'dueAt', 'candidate', 'cutoff', 'sourceStatus', 'missing'])(
    'rejects a changed %s fingerprint after Trip verification',
    async (change) => {
      const s = setup();
      s.trip.getAccessContext.mockImplementation(async () => {
        if (change === 'financeVersion') s.current.financeVersion++;
        if (change === 'dueAt') s.current.dueAt = null;
        if (change === 'candidate') s.current.candidates = [];
        if (change === 'cutoff') s.current.candidates[0]!.cutoffMicros = '1792886400000000';
        if (change === 'sourceStatus') s.current.sourceStatus = 'CONFIRMED';
        if (change === 'missing') s.repository.find.mockResolvedValue(null);
        return access();
      });
      await expect(s.service.get(input, correlation, deadline())).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    },
  );

  it.each([NaN, Infinity, -Infinity, 0])(
    'rejects expired or nonfinite deadline %s before work',
    async (until) => {
      const s = setup();
      await expect(s.service.get(input, correlation, until)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(s.repository.find).not.toHaveBeenCalled();
    },
  );

  it('does not renew a deadline after a slow Trip response', async () => {
    const s = setup();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    s.trip.getAccessContext.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(201);
      return access();
    });
    await expect(s.service.get(input, correlation, 200)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(s.repository.find).toHaveBeenCalledTimes(1);
  });

  it('checks a complete audience with at most eight concurrent Trip requests', async () => {
    const s = setup();
    s.current.candidates = Array.from({ length: 18 }, (_, index) => ({
      userId: '40000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
      cutoffMicros: '1792886400123456',
    }));
    let active = 0,
      maximum = 0;
    const pending: Array<() => void> = [];
    s.trip.getAccessContext.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          pending.push(() => {
            active--;
            resolve(access(request.user_id));
          });
        }),
    );
    const work = s.service.get(input, correlation, deadline());
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending.splice(0).forEach((resolve) => resolve());
    expect((await work).authorized_recipients).toHaveLength(18);
    expect(maximum).toBe(8);
    expect(active).toBe(0);
  });
});
