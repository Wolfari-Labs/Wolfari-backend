import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceOutboxRepository, type ClaimedFinanceEvent } from './finance-outbox.repository';
import { FinanceOutboxService } from './finance-outbox.service';

const id = '10000000-0000-4000-8000-000000000001';
function claim(attempt = 1): ClaimedFinanceEvent {
  return {
    event_id: id,
    event_type: 'ContributionUpdated',
    schema_version: 1,
    occurred_at: '2026-10-25T12:00:00.123456Z',
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: id,
    aggregate_version: 2,
    correlation_id: id,
    causation_id: null,
    operation_id: null,
    trip_id: id,
    actor_user_id: id,
    system_actor: null,
    payload: {
      fund_id: id,
      trip_id: id,
      contribution_id: id,
      status: 'PENDING',
      finance_version: 2,
    },
    claim_owner: '20000000-0000-4000-8000-000000000001',
    claim_until: new Date('2099-01-01T00:00:00.000Z'),
    attempt_count: attempt,
  };
}
function setup(enabled?: unknown) {
  const repository = {
    claimNext: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
    diagnostics: vi.fn().mockResolvedValue({ pending: 2, failed: 1 }),
  };
  const publisher = {
    publish: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    connected: true,
  };
  const config = { get: vi.fn().mockReturnValue(enabled) };
  return {
    repository,
    publisher,
    service: new FinanceOutboxService(repository, publisher, config as never),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Finance durable outbox worker', () => {
  it('publishes the stored event then acknowledges it, outside repository claim work', async () => {
    const s = setup(),
      value = claim();
    s.repository.claimNext.mockResolvedValueOnce(value);
    await s.service.runOnce();
    expect(s.publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: id,
        aggregate_version: 2,
        occurred_at: '2026-10-25T12:00:00.123456Z',
        payload: value.payload,
      }),
    );
    expect(s.publisher.publish.mock.calls[0]?.[0]).not.toHaveProperty('claim_owner');
    expect(s.repository.complete).toHaveBeenCalledWith(value);
    expect(s.repository.complete.mock.invocationCallOrder[0]).toBeGreaterThan(
      s.publisher.publish.mock.invocationCallOrder[0]!,
    );
    expect(s.repository.fail).not.toHaveBeenCalled();
  });

  it('quarantines an invalid row and continues to a valid sibling without leaking validation data', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const s = setup(),
      invalid = { ...claim(), payload: { ...claim().payload, secret: 'PRIVATE-SENTINEL' } };
    s.repository.claimNext.mockResolvedValueOnce(invalid).mockResolvedValueOnce(claim());
    await s.service.runOnce();
    expect(s.repository.fail).toHaveBeenCalledWith(invalid, 'INVALID_EVENT', true);
    expect(s.publisher.publish).toHaveBeenCalledTimes(1);
    expect(s.repository.complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE-SENTINEL');
  });

  it('schedules failed broker attempts without marking them PUBLISHED', async () => {
    const s = setup(),
      value = claim(6);
    s.repository.claimNext.mockResolvedValueOnce(value);
    s.publisher.publish.mockRejectedValue(new Error('PRIVATE-BROKER-URL'));
    await s.service.runOnce();
    expect(s.repository.fail).toHaveBeenCalledWith(value, 'PUBLISH_FAILED');
    expect(s.repository.complete).not.toHaveBeenCalled();
  });

  it('leaves a confirmed event reclaimable if SQL acknowledgement fails, then republishes identical identity', async () => {
    const s = setup();
    s.repository.claimNext.mockResolvedValueOnce(claim()).mockResolvedValueOnce(claim(2));
    s.repository.complete.mockRejectedValueOnce(new Error('database outage'));
    await expect(s.service.runOnce()).rejects.toThrow('database outage');
    expect(s.repository.fail).not.toHaveBeenCalled();
    await s.service.runOnce();
    expect(s.publisher.publish).toHaveBeenCalledTimes(2);
    expect(s.publisher.publish.mock.calls[0]?.[0]).toEqual(s.publisher.publish.mock.calls[1]?.[0]);
  });

  it('does not rewrite another claim when finalization reports stale ownership', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const s = setup();
    s.repository.claimNext.mockResolvedValueOnce(claim());
    s.repository.complete.mockResolvedValue(false);
    await s.service.runOnce();
    expect(s.repository.fail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('FINANCE_OUTBOX_STALE_COMPLETION');
  });

  it('limits a cycle to ten sequential claims and shares one in-flight cycle', async () => {
    const s = setup();
    s.repository.claimNext.mockResolvedValue(claim());
    let release!: () => void;
    s.publisher.publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = s.service.runOnce();
    expect(s.service.runOnce()).toBe(first);
    await vi.waitFor(() => expect(s.publisher.publish).toHaveBeenCalledTimes(1));
    expect(s.repository.claimNext).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(s.repository.claimNext).toHaveBeenCalledTimes(10);
    expect(s.publisher.publish).toHaveBeenCalledTimes(10);
    expect(s.repository.complete).toHaveBeenCalledTimes(10);
  });

  it.each([undefined, 'false', true, 'TRUE', '1'])(
    'does not start background work for %s',
    async (enabled) => {
      vi.useFakeTimers();
      const s = setup(enabled);
      s.service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(3000);
      expect(s.repository.claimNext).not.toHaveBeenCalled();
      await s.service.runOnce();
      expect(s.repository.claimNext).toHaveBeenCalledTimes(1);
      await s.service.onApplicationShutdown();
    },
  );

  it('starts one background loop only for the explicit true setting', async () => {
    vi.useFakeTimers();
    const s = setup('true');
    s.service.onApplicationBootstrap();
    s.service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.repository.claimNext).toHaveBeenCalledTimes(2);
    await s.service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.repository.claimNext).toHaveBeenCalledTimes(2);
  });

  it('stops new claims and waits for the in-flight failure after transport close aborts it', async () => {
    const s = setup(),
      value = claim();
    s.repository.claimNext.mockResolvedValueOnce(value);
    let abort!: (error: Error) => void;
    s.publisher.publish.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          abort = reject;
        }),
    );
    s.publisher.close.mockImplementation(async () => {
      abort(new Error('closed'));
    });
    const work = s.service.runOnce();
    await vi.waitFor(() => expect(s.publisher.publish).toHaveBeenCalledTimes(1));
    await s.service.onApplicationShutdown();
    await work;
    expect(s.repository.fail).toHaveBeenCalledWith(value, 'PUBLISH_FAILED');
    await s.service.runOnce();
    expect(s.repository.claimNext).toHaveBeenCalledTimes(1);
  });

  it('does not publish a claim acquired while shutdown was waiting for the database', async () => {
    const s = setup();
    let release!: (value: ClaimedFinanceEvent) => void;
    s.repository.claimNext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const work = s.service.runOnce();
    const closing = s.service.onApplicationShutdown();
    release(claim());
    await Promise.all([work, closing]);
    expect(s.publisher.publish).not.toHaveBeenCalled();
    expect(s.repository.claimNext).toHaveBeenCalledTimes(1);
    expect(s.repository.complete).not.toHaveBeenCalled();
  });

  it('finishes shutdown when an actual repository client response stalls', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const query = vi.fn().mockImplementation(
      (config) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Query read timeout')), config.query_timeout);
        }),
    );
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    const repository = new FinanceOutboxRepository({ pool } as never);
    const s = setup();
    const service = new FinanceOutboxService(repository, s.publisher, {
      get: () => undefined,
    } as never);
    const work = service.runOnce().catch((error) => error);
    const closing = service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await work).toBeInstanceOf(Error);
    await closing;
    expect(release).toHaveBeenCalledWith(true);
    expect(s.publisher.publish).not.toHaveBeenCalled();
    expect(s.publisher.close).toHaveBeenCalledTimes(1);
  });

  it('returns only aggregate operational diagnostics', async () => {
    const s = setup('true');
    expect(await s.service.diagnostics()).toEqual({
      enabled: true,
      broker: 'up',
      outbox: { pending: 2, failed: 1 },
    });
  });
});
