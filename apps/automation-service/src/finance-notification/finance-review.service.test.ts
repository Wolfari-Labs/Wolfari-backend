import { randomUUID } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import {
  financeNotificationEvent,
  InvalidFinanceNotificationEvent,
} from './finance-notification.event';
import { FinanceNotificationService } from './finance-notification.service';

function envelope(contributionStatus = 'TRANSFER_REPORTED') {
  const fund = randomUUID(),
    trip = randomUUID();
  return {
    event_id: randomUUID(),
    event_type: 'ContributionUpdated',
    schema_version: 1,
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: fund,
    aggregate_version: 7,
    trip_id: trip,
    correlation_id: randomUUID(),
    operation_id: randomUUID(),
    actor_user_id: randomUUID(),
    causation_id: null,
    system_actor: null,
    occurred_at: '2026-10-28T12:00:00.123456Z',
    payload: {
      fund_id: fund,
      trip_id: trip,
      contribution_id: randomUUID(),
      status: contributionStatus,
      finance_version: 7,
    },
  };
}
function setup(contributionStatus = 'TRANSFER_REPORTED') {
  const event = financeNotificationEvent(envelope(contributionStatus));
  const holder = randomUUID();
  const context = {
    finance_version: 9,
    status: 1,
    source_revision: 4,
    authorized_recipients: [{ user_id: holder }],
  };
  const client = {
    getContext: vi.fn().mockResolvedValue(context),
    getEligibility: vi
      .fn()
      .mockResolvedValue({ recipients: [{ user_id: holder, eligible: true }] }),
  };
  const repository = {
    isProcessed: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue('APPLIED'),
  };
  return {
    event,
    holder,
    context,
    client,
    repository,
    service: new FinanceNotificationService(client, repository),
  };
}

describe('Holder review event and current source boundary', () => {
  it('ignores additive private fields but fingerprints every known event field', () => {
    const input = envelope();
    const event = financeNotificationEvent(input);
    expect(
      financeNotificationEvent({ ...input, payload: { ...input.payload, account: 'PRIVATE' } }),
    ).toEqual(event);
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
    for (const payload of [
      { ...input.payload, contribution_id: randomUUID() },
      { ...input.payload, status: 'PENDING' },
    ])
      expect(financeNotificationEvent({ ...input, payload }).fingerprint).not.toBe(
        event.fingerprint,
      );
  });
  it.each([
    { producer: 'Trip' },
    { aggregate_type: 'Trip' },
    { schema_version: 2 },
    { aggregate_version: 8 },
    { trip_id: randomUUID() },
  ])('rejects inconsistent envelopes %j', (change) => {
    expect(() => financeNotificationEvent({ ...envelope(), ...change })).toThrow(
      InvalidFinanceNotificationEvent,
    );
  });
  it.each(['PENDING', 'TRANSFER_REPORTED', 'CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'])(
    'uses %s as an invalidation signal for the current report revision',
    async (sourceStatus) => {
      const h = setup(sourceStatus);
      await h.service.process(h.event);
      expect(h.client.getContext).toHaveBeenCalledTimes(2);
      expect(h.client.getEligibility).toHaveBeenCalledWith(
        [h.holder],
        h.event.correlationId,
        expect.any(Number),
      );
      expect(h.repository.complete).toHaveBeenCalledWith(h.event, [h.holder], 4);
    },
  );
  it.each([undefined, null, 0, -1, 1.5, 2147483648, '4'])(
    'rejects missing or invalid review revision %s, including an older Finance response',
    async (revision) => {
      const h = setup();
      h.client.getContext.mockResolvedValue({ ...h.context, source_revision: revision });
      await expect(h.service.process(h.event)).rejects.toThrow();
      expect(h.repository.complete).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: 2 },
    { status: 3 },
    { due_at: { seconds: '1' } },
    { authorized_recipients: [{ user_id: randomUUID() }, { user_id: randomUUID() }] },
    { authorized_recipients: null },
    { finance_version: 6 },
  ])('rejects malformed or unauthorized current review context %j', async (change) => {
    const h = setup();
    h.client.getContext.mockResolvedValue({ ...h.context, ...change });
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('suppresses an ineligible current source in Fund state %i', async (state) => {
    const h = setup();
    h.client.getContext.mockResolvedValue({
      ...h.context,
      status: state,
      authorized_recipients: [],
    });
    await h.service.process(h.event);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, [], 4);
    expect(h.client.getEligibility).not.toHaveBeenCalled();
  });
  it('suppresses two trusted missing-source reads with no revision or Identity call', async () => {
    const h = setup();
    h.client.getContext.mockRejectedValue({
      code: status.NOT_FOUND,
      details: JSON.stringify({ code: 'RESOURCE_NOT_FOUND' }),
    });
    await h.service.process(h.event);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, [], undefined);
    expect(h.client.getEligibility).not.toHaveBeenCalled();
  });
  it('does not notify a locked Holder', async () => {
    const h = setup();
    h.client.getEligibility.mockResolvedValue({ recipients: [{ user_id: h.holder }] });
    await h.service.process(h.event);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, [], 4);
  });
  it.each([{ source_revision: 5 }, { authorized_recipients: [] }, { finance_version: 10 }])(
    'retries changing source %j instead of committing a stale read',
    async (change) => {
      const h = setup();
      h.client.getContext
        .mockResolvedValueOnce(h.context)
        .mockResolvedValueOnce({ ...h.context, ...change });
      await expect(h.service.process(h.event)).rejects.toThrow();
      expect(h.repository.complete).not.toHaveBeenCalled();
    },
  );
  it('retries Identity failure without committing', async () => {
    const h = setup();
    h.client.getEligibility.mockRejectedValue(new Error('unavailable'));
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it('acknowledges a processed event without querying unavailable dependencies', async () => {
    const h = setup();
    h.repository.isProcessed.mockResolvedValue(true);
    await h.service.process(h.event);
    expect(h.client.getContext).not.toHaveBeenCalled();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
});
