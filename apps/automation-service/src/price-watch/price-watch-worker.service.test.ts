import { describe, expect, it, vi } from 'vitest';
import { PriceProviderFailure } from './price-watch-worker.domain';
import { PriceWatchWorkerService } from './price-watch-worker.service';

const attempt = {
  id: '11111111-1111-4111-8111-111111111111',
  query_group_id: '22222222-2222-4222-8222-222222222222',
  scheduled_slot: '2026-10-22T12:00:00.000Z',
  attempt_count: 1,
  canonical_key: 'canonical',
  query: {
    provider: 'MOCK_FLIGHT' as const,
    transport_type: 'FLIGHT' as const,
    origin: 'DAD',
    destination: 'SGN',
    departure_date: '2099-11-01',
    return_date: null,
    journey_type: 'ONE_WAY' as const,
    adults: 1,
    children: 0,
    infants: 0,
    passenger_count: 1,
    cabin_class: 'ECONOMY' as const,
    currency: 'VND' as const,
    departure_at: '2099-11-01T02:00:00.000Z',
  },
};

function setup(result: unknown) {
  const repository = {
    scheduleDue: vi.fn().mockResolvedValue({}),
    failExhaustedLeases: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn().mockResolvedValueOnce(attempt).mockResolvedValueOnce(undefined),
    completeSuccess: vi.fn().mockResolvedValue(true),
    completeNoResult: vi.fn().mockResolvedValue(true),
    completeFailure: vi.fn().mockResolvedValue('RETRY'),
  };
  const provider = {
    fetch:
      result instanceof Error
        ? vi.fn().mockRejectedValue(result)
        : vi.fn().mockResolvedValue(result),
  };
  const values: Record<string, string> = {
    NODE_ENV: 'test',
    PRICE_WATCH_WORKER_ENABLED: 'true',
    PRICE_WATCH_WORKER_POLL_MS: '100',
    PRICE_WATCH_ATTEMPT_LEASE_MS: '1000',
    PRICE_WATCH_PROVIDER_TIMEOUT_MS: '50',
    PRICE_WATCH_WORKER_BATCH_SIZE: '2',
  };
  const config = { get: (key: string) => values[key] };
  const service = new PriceWatchWorkerService(
    config as never,
    repository as never,
    provider as never,
  );
  return { service, repository, provider };
}

describe('PriceWatchWorkerService', () => {
  it('schedules, claims and atomically completes a valid quote', async () => {
    const { service, repository, provider } = setup({
      kind: 'SUCCESS',
      price: '1500000',
      currency: 'VND',
      provider: 'MOCK_FLIGHT',
      fare_metadata: { carrier_code: 'WF' },
    });
    await service.runCycle(new Date('2026-10-22T12:30:00.000Z'));
    expect(repository.scheduleDue).toHaveBeenCalledWith(new Date('2026-10-22T12:30:00.000Z'), 2);
    expect(provider.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: 'canonical', scheduledSlot: attempt.scheduled_slot }),
    );
    expect(repository.completeSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/^price-watch:/),
      attempt,
      expect.objectContaining({ price: '1500000' }),
    );
  });

  it('finishes no-result without writing an observation', async () => {
    const { service, repository } = setup({ kind: 'NO_RESULT' });
    await service.runCycle();
    expect(repository.completeNoResult).toHaveBeenCalled();
    expect(repository.completeSuccess).not.toHaveBeenCalled();
  });

  it('retries sanitized transient failures on the same attempt', async () => {
    const { service, repository } = setup(new Error('raw provider secret'));
    await service.runCycle();
    expect(repository.completeFailure).toHaveBeenCalledWith(
      expect.stringMatching(/^price-watch:/),
      attempt,
      'PROVIDER_UNAVAILABLE',
      true,
    );
  });

  it('fails malformed responses permanently', async () => {
    const { service, repository } = setup({
      kind: 'SUCCESS',
      price: '0',
      currency: 'VND',
      provider: 'MOCK_FLIGHT',
      fare_metadata: {},
    });
    await service.runCycle();
    expect(repository.completeFailure).toHaveBeenCalledWith(
      expect.any(String),
      attempt,
      'PROVIDER_RESPONSE_INVALID',
      false,
    );
  });

  it('leaves a claimed attempt for lease recovery when database finalization fails', async () => {
    const { service, repository } = setup({
      kind: 'SUCCESS',
      price: '1500000',
      currency: 'VND',
      provider: 'MOCK_FLIGHT',
      fare_metadata: {},
    });
    repository.completeSuccess.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.runCycle()).rejects.toThrow('database unavailable');
    expect(repository.completeFailure).not.toHaveBeenCalled();
  });

  it('classifies provider timeout as transient', async () => {
    vi.useFakeTimers();
    try {
      const { service, repository, provider } = setup(undefined);
      provider.fetch.mockImplementation(() => new Promise(() => {}));
      const running = service.runCycle();
      await vi.advanceTimersByTimeAsync(50);
      await running;
      expect(repository.completeFailure).toHaveBeenCalledWith(
        expect.any(String),
        attempt,
        'PROVIDER_TIMEOUT',
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects timeout values that are not shorter than the lease', () => {
    const config = {
      get: (key: string) =>
        ({
          PRICE_WATCH_ATTEMPT_LEASE_MS: '1000',
          PRICE_WATCH_PROVIDER_TIMEOUT_MS: '1000',
        })[key],
    };
    expect(() => new PriceWatchWorkerService(config as never, {} as never, {} as never)).toThrow(
      'shorter than the lease',
    );
  });

  it('preserves known provider failure classification', async () => {
    const { service, repository } = setup(
      new PriceProviderFailure('PROVIDER_NOT_SUPPORTED', false),
    );
    await service.runCycle();
    expect(repository.completeFailure).toHaveBeenCalledWith(
      expect.any(String),
      attempt,
      'PROVIDER_NOT_SUPPORTED',
      false,
    );
  });
});
