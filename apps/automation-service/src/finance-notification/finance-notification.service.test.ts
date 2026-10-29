import { describe, expect, it, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import { FinanceNotificationService } from './finance-notification.service';
import {
  contributionNotificationEvent,
  notificationEnabled,
  InvalidFinanceNotificationEvent,
} from './finance-notification.event';

const ids = Array.from({ length: 210 }, () => randomUUID());
function envelope() {
  return {
    event_id: randomUUID(),
    event_type: 'ContributionRequested',
    schema_version: 1,
    occurred_at: '2026-10-28T10:00:00.123456Z',
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: ids[0],
    aggregate_version: 7,
    correlation_id: ids[1],
    causation_id: null,
    operation_id: ids[2],
    trip_id: ids[3],
    actor_user_id: ids[4],
    system_actor: null,
    payload: {
      fund_id: ids[0],
      trip_id: ids[3],
      request_id: ids[5],
      contribution_ids: ids.slice(6),
      finance_version: 7,
    },
  };
}
function setup(users = ids.slice(6, 8)) {
  const event = contributionNotificationEvent(envelope());
  const snapshot = {
    finance_version: 8,
    status: 1,
    authorized_recipients: users.map((user_id) => ({ user_id })),
  };
  const client = {
    getContext: vi.fn().mockResolvedValue(snapshot),
    getEligibility: vi.fn().mockImplementation(async (batch: string[]) => ({
      recipients: batch.map((user_id) => ({ user_id, eligible: true })),
    })),
  };
  const repository = {
    isProcessed: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue('APPLIED'),
  };
  return {
    service: new FinanceNotificationService(client, repository),
    event,
    snapshot,
    client,
    repository,
  };
}
afterEach(() => vi.restoreAllMocks());
describe('Finance contribution event boundary', () => {
  it('accepts additive fields but projects no event content into the inbox model', () => {
    const input = envelope();
    const a = contributionNotificationEvent(input);
    const b = contributionNotificationEvent({
      ...input,
      future: 'PRIVATE',
      payload: { ...input.payload, future: 'PRIVATE' },
    });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('PRIVATE');
    expect(a.contributionCount).toBe(204);
  });
  it.each([
    { producer: 'Trip' },
    { aggregate_type: 'Trip' },
    { schema_version: 2 },
    { event_type: 'FinanceClosed' },
    { aggregate_version: 8 },
    { trip_id: randomUUID() },
    { aggregate_id: randomUUID() },
    { event_id: 'invalid' },
  ])('rejects an unsupported or inconsistent envelope %j', (change) => {
    expect(() => contributionNotificationEvent({ ...envelope(), ...change })).toThrow(
      InvalidFinanceNotificationEvent,
    );
  });
  it('rejects duplicate contribution IDs', () => {
    const input = envelope();
    input.payload.contribution_ids = [ids[6]!, ids[6]!];
    expect(() => contributionNotificationEvent(input)).toThrow(InvalidFinanceNotificationEvent);
  });
  it('defaults off and rejects malformed activation flags', () => {
    for (const value of [undefined, '', 'false']) expect(notificationEnabled(value)).toBe(false);
    expect(notificationEnabled('true')).toBe(true);
    for (const value of [true, 'TRUE', '1', ' false '])
      expect(() => notificationEnabled(value)).toThrow();
  });
});
describe('Finance notification current recipient checks', () => {
  it('allows a newer Fund version, checks twice and includes an actor who is a debtor', async () => {
    const h = setup([ids[4]!]);
    await h.service.process(h.event);
    expect(h.client.getContext).toHaveBeenCalledTimes(2);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, [ids[4]]);
  });
  it('batches >100 recipients and never consults external channel preferences', async () => {
    const h = setup(ids.slice(6));
    await h.service.process(h.event);
    expect(h.client.getEligibility.mock.calls.map((call) => call[0].length)).toEqual([100, 100, 4]);
    expect(h.repository.complete.mock.calls[0]![1]).toHaveLength(204);
  });
  it('handles protobuf omitted false as ineligible without dropping the whole event', async () => {
    const h = setup();
    h.client.getEligibility.mockResolvedValue({
      recipients: [{ user_id: ids[6], eligible: true }, { user_id: ids[7] }],
    });
    await h.service.process(h.event);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, [ids[6]]);
  });
  it('dedupes a committed event without dependencies even during an outage', async () => {
    const h = setup();
    h.repository.isProcessed.mockResolvedValue(true);
    await h.service.process(h.event);
    expect(h.client.getContext).not.toHaveBeenCalled();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it.each([undefined, []])(
    'suppresses empty protobuf audience %j after revalidation',
    async (recipients) => {
      const h = setup();
      h.client.getContext.mockResolvedValue({
        finance_version: 8,
        status: 1,
        authorized_recipients: recipients,
      });
      await h.service.process(h.event);
      expect(h.client.getEligibility).not.toHaveBeenCalled();
      expect(h.repository.complete).toHaveBeenCalledWith(h.event, []);
    },
  );
  it('suppresses a trusted missing source only when both reads agree', async () => {
    const h = setup();
    h.client.getContext.mockRejectedValue({
      code: status.NOT_FOUND,
      details: '{"code":"RESOURCE_NOT_FOUND"}',
    });
    await h.service.process(h.event);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, []);
  });
  it.each([
    { finance_version: 6, status: 1 },
    { finance_version: 0, status: 1 },
    { finance_version: 8, status: 0 },
    { finance_version: 8, status: 9 },
    { finance_version: 8, status: 2, authorized_recipients: [{ user_id: ids[6] }] },
    { finance_version: 8, status: 1, authorized_recipients: [{ user_id: 'bad' }] },
    {
      finance_version: 8,
      status: 1,
      authorized_recipients: [{ user_id: ids[6] }, { user_id: ids[6] }],
    },
    { finance_version: 8, status: 1, due_at: { seconds: 'bad' } },
    { finance_version: 8, status: 1, due_at: { seconds: '1', nanos: -1 } },
  ])('retries malformed/stale source response %j without writes', async (value) => {
    const h = setup();
    h.client.getContext.mockResolvedValue(value);
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { recipients: [] },
    { recipients: [{ user_id: ids[6], eligible: true }] },
    { recipients: [{ user_id: ids[6] }, { user_id: ids[6] }] },
    { recipients: [{ user_id: ids[6] }, { user_id: ids[8] }] },
    { recipients: [{ user_id: ids[6], eligible: 'true' }, { user_id: ids[7] }] },
  ])('retries incomplete/invalid Identity response %j without partial writes', async (value) => {
    const h = setup();
    h.client.getEligibility.mockResolvedValue(value);
    await expect(h.service.process(h.event)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it.each(['version', 'audience', 'deadline', 'missing'])(
    'rejects a changing %s between checks',
    async (kind) => {
      const h = setup();
      h.client.getContext.mockResolvedValueOnce(h.snapshot);
      if (kind === 'missing')
        h.client.getContext.mockRejectedValueOnce({
          code: status.NOT_FOUND,
          details: '{"code":"RESOURCE_NOT_FOUND"}',
        });
      else
        h.client.getContext.mockResolvedValueOnce({
          ...h.snapshot,
          ...(kind === 'version'
            ? { finance_version: 9 }
            : kind === 'audience'
              ? { authorized_recipients: [] }
              : { due_at: { seconds: '1' } }),
        });
      await expect(h.service.process(h.event)).rejects.toThrow();
      expect(h.repository.complete).not.toHaveBeenCalled();
    },
  );
  it.each(['getContext', 'getEligibility'] as const)(
    'propagates %s outage rather than suppressing',
    async (method) => {
      const h = setup();
      h.client[method].mockRejectedValue(new Error('private dependency error'));
      await expect(h.service.process(h.event)).rejects.toThrow();
      expect(h.repository.complete).not.toHaveBeenCalled();
    },
  );
  it('does not trust an arbitrary NOT_FOUND without the service error envelope', async () => {
    const h = setup();
    h.client.getContext.mockRejectedValue({ code: status.NOT_FOUND });
    await expect(h.service.process(h.event)).rejects.toBeDefined();
    expect(h.repository.complete).not.toHaveBeenCalled();
  });
  it('aborts before committing after shutdown or budget exhaustion', async () => {
    for (const abort of [true, false]) {
      const h = setup(),
        signal = new AbortController();
      h.client.getEligibility.mockImplementation(async () => {
        if (abort) signal.abort();
        else vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
        return { recipients: [{ user_id: ids[6] }, { user_id: ids[7] }] };
      });
      await expect(h.service.process(h.event, signal.signal)).rejects.toThrow();
      expect(h.repository.complete).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
});
