import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  financeNotificationEvent,
  InvalidFinanceNotificationEvent,
} from './finance-notification.event';
import { FinanceNotificationService } from './finance-notification.service';

function envelope(type = 'ClosureCancelled') {
  const fund = randomUUID(),
    trip = randomUUID();
  return {
    event_id: randomUUID(),
    event_type: type,
    schema_version: 1,
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: fund,
    aggregate_version: 9,
    trip_id: trip,
    correlation_id: randomUUID(),
    operation_id: randomUUID(),
    actor_user_id: randomUUID(),
    causation_id: null,
    system_actor: null,
    occurred_at: '2026-10-29T03:00:00.123456Z',
    payload: { fund_id: fund, trip_id: trip, closure_id: randomUUID(), finance_version: 9 },
  };
}
function setup(type: string) {
  const event = financeNotificationEvent(envelope(type));
  const client = {
    getContext: vi.fn().mockRejectedValue(new Error('SOURCE_DOWN')),
    getEligibility: vi.fn().mockRejectedValue(new Error('IDENTITY_DOWN')),
  };
  const repository = {
    isProcessed: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue('APPLIED'),
  };
  return { event, client, repository, service: new FinanceNotificationService(client, repository) };
}

describe.each(['ClosureCancelled', 'FinanceClosed'])('%s terminal boundary', (type) => {
  it('persists a deny-only barrier even when source/account services are unavailable', async () => {
    const h = setup(type);
    await h.service.process(h.event);
    expect(h.repository.complete).toHaveBeenCalledWith(h.event, []);
    expect(h.client.getContext).not.toHaveBeenCalled();
    expect(h.client.getEligibility).not.toHaveBeenCalled();
  });
  it('short-circuits committed redelivery and propagates database failures', async () => {
    const h = setup(type);
    h.repository.isProcessed.mockResolvedValueOnce(true);
    await h.service.process(h.event);
    expect(h.repository.complete).not.toHaveBeenCalled();
    h.repository.complete.mockRejectedValueOnce(new Error('DB_DOWN'));
    await expect(h.service.process(h.event)).rejects.toThrow('DB_DOWN');
  });
  it('honors cancellation before and after the inbox lookup', async () => {
    const h = setup(type),
      controller = new AbortController();
    h.repository.isProcessed.mockImplementation(async () => {
      controller.abort();
      return false;
    });
    await expect(h.service.process(h.event, controller.signal)).rejects.toThrow();
    expect(h.repository.complete).not.toHaveBeenCalled();
    await expect(h.service.process(h.event, controller.signal)).rejects.toThrow();
    expect(h.repository.isProcessed).toHaveBeenCalledTimes(1);
  });
  it('projects only known identifiers and fingerprints terminal type/closure identity', () => {
    const input = envelope(type),
      event = financeNotificationEvent(input);
    expect(
      financeNotificationEvent({ ...input, payload: { ...input.payload, private: 'PRIVATE' } }),
    ).toEqual(event);
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
    expect(
      financeNotificationEvent({
        ...input,
        event_type: type === 'FinanceClosed' ? 'ClosureCancelled' : 'FinanceClosed',
      }).fingerprint,
    ).not.toBe(event.fingerprint);
    expect(
      financeNotificationEvent({
        ...input,
        payload: { ...input.payload, closure_id: randomUUID() },
      }).fingerprint,
    ).not.toBe(event.fingerprint);
  });
  it.each([
    { producer: 'Trip' },
    { aggregate_type: 'Trip' },
    { schema_version: 2 },
    { aggregate_version: 10 },
    { aggregate_id: randomUUID() },
    { trip_id: randomUUID() },
  ])('rejects inconsistent terminal envelopes %j', (change) => {
    expect(() => financeNotificationEvent({ ...envelope(type), ...change })).toThrow(
      InvalidFinanceNotificationEvent,
    );
  });
  it('rejects missing/invalid closure identity', () => {
    const input = envelope(type);
    for (const closure_id of [undefined, null, '', 'not-a-uuid'])
      expect(() =>
        financeNotificationEvent({ ...input, payload: { ...input.payload, closure_id } }),
      ).toThrow(InvalidFinanceNotificationEvent);
  });
});
