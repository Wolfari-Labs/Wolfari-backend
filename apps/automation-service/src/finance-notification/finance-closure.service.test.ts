import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FinanceNotificationService } from './finance-notification.service';
import {
  contributionNotificationEvent,
  financeNotificationEvent,
  InvalidFinanceNotificationEvent,
} from './finance-notification.event';

const users = Array.from({ length: 201 }, () => randomUUID());
function envelope() {
  const fund = randomUUID(),
    trip = randomUUID();
  return {
    event_id: randomUUID(),
    event_type: 'ClosureRequested',
    schema_version: 1,
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: fund,
    aggregate_version: 7,
    trip_id: trip,
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: randomUUID(),
    actor_user_id: users[0],
    system_actor: null,
    occurred_at: '2026-10-28T12:00:00.123456Z',
    payload: {
      fund_id: fund,
      trip_id: trip,
      closure_id: randomUUID(),
      snapshot_hash: 'a'.repeat(64),
      finance_version: 7,
    },
  };
}
function setup() {
  const event = financeNotificationEvent(envelope());
  const context = {
    finance_version: 8,
    status: 2,
    authorized_recipients: users.map((user_id) => ({ user_id })),
  };
  const client = {
    getContext: vi.fn().mockResolvedValue(context),
    getEligibility: vi.fn().mockImplementation(async (batch: string[]) => ({
      recipients: batch.map((user_id) => ({ user_id, eligible: true })),
    })),
  };
  const repository = {
    isProcessed: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue('APPLIED'),
  };
  return {
    event,
    context,
    client,
    repository,
    service: new FinanceNotificationService(client, repository),
  };
}

describe('Closure notification boundary', () => {
  it('projects only IDs/hash and ignores compatible additive private content', () => {
    const value = envelope();
    expect(
      financeNotificationEvent({ ...value, payload: { ...value.payload, snapshot: 'PRIVATE' } }),
    ).toEqual(financeNotificationEvent(value));
    expect(JSON.stringify(financeNotificationEvent(value))).not.toContain('PRIVATE');
    expect(financeNotificationEvent(value)).toMatchObject({
      closureId: value.payload.closure_id,
      snapshotHash: 'a'.repeat(64),
    });
  });
  it('retains the existing ContributionRequested projection and fingerprint', () => {
    const base = envelope();
    const value = {
      ...base,
      event_type: 'ContributionRequested',
      payload: {
        fund_id: base.aggregate_id,
        trip_id: base.trip_id,
        finance_version: base.aggregate_version,
        request_id: randomUUID(),
        contribution_ids: [randomUUID()],
      },
    };
    expect(financeNotificationEvent(value)).toEqual(contributionNotificationEvent(value));
  });
  it.each([
    { producer: 'Trip' },
    { aggregate_type: 'Trip' },
    { schema_version: 2 },
    { trip_id: randomUUID() },
    { aggregate_id: randomUUID() },
    { aggregate_version: 8 },
  ])('rejects unsupported/inconsistent envelope %j', (change) => {
    expect(() => financeNotificationEvent({ ...envelope(), ...change })).toThrow(
      InvalidFinanceNotificationEvent,
    );
  });
  it.each(['bad', '', 'g'.repeat(64), 'a'.repeat(63)])(
    'rejects invalid snapshot hash %s',
    (hash) => {
      const value = envelope();
      value.payload.snapshot_hash = hash;
      expect(() => financeNotificationEvent(value)).toThrow(InvalidFinanceNotificationEvent);
    },
  );
  it('fingerprints snapshot identity and event ID independently of Fund version', () => {
    const value = envelope(),
      original = financeNotificationEvent(value);
    expect(
      financeNotificationEvent({
        ...value,
        payload: { ...value.payload, snapshot_hash: 'b'.repeat(64) },
      }).fingerprint,
    ).not.toBe(original.fingerprint);
    expect(financeNotificationEvent({ ...value, event_id: randomUUID() }).fingerprint).not.toBe(
      original.fingerprint,
    );
  });
});

describe('Closure current recipient orchestration', () => {
  it('checks CLOSING recipients in bounded batches, includes the actor and rechecks Finance', async () => {
    const h = setup();
    await h.service.process(h.event);
    expect(h.client.getContext).toHaveBeenCalledTimes(2);
    expect(h.client.getEligibility.mock.calls.map((call) => call[0].length)).toEqual([100, 100, 1]);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, [...users].sort());
  });
  it.each([1, 2, 3])('suppresses a stable empty source in Fund state %i', async (status) => {
    const h = setup();
    h.client.getContext.mockResolvedValue({ finance_version: 8, status });
    await h.service.process(h.event);
    expect(h.client.getEligibility).not.toHaveBeenCalled();
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, []);
  });
  it.each([
    { status: 1 },
    { status: 3 },
    { due_at: { seconds: '1' } },
    { authorized_recipients: null },
    { authorized_recipients: [{ user_id: users[0] }, { user_id: users[0] }] },
    { finance_version: 6 },
  ])('retries invalid closure context %j without writes', async (change) => {
    const h = setup();
    h.client.getContext.mockResolvedValue({ ...h.context, ...change });
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it('never commits a partial audience when the last Identity batch fails', async () => {
    const h = setup();
    h.client.getEligibility.mockResolvedValueOnce({
      recipients: users
        .slice()
        .sort()
        .slice(0, 100)
        .map((user_id) => ({ user_id, eligible: true })),
    });
    h.client.getEligibility.mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it('retries when a member confirms between the two Finance checks', async () => {
    const h = setup();
    h.client.getContext.mockResolvedValueOnce(h.context).mockResolvedValueOnce({
      ...h.context,
      authorized_recipients: h.context.authorized_recipients.slice(1),
    });
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it('deduplicates a previously suppressed reminder even when dependencies are down', async () => {
    const h = setup();
    h.repository.isProcessed.mockResolvedValue(true);
    await h.service.process(h.event);
    expect(h.client.getContext).not.toHaveBeenCalled();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
});
