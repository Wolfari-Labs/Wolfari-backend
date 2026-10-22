import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PriceWatchError } from './price-watch.errors';
import { PriceAlertService } from './price-alert.service';

const candidate = {
  id: '10000000-0000-4000-8000-000000000001',
  watch_id: '10000000-0000-4000-8000-000000000002',
  observation_id: '10000000-0000-4000-8000-000000000003',
  watch_version: 1,
  attempt_count: 1,
  user_id: '10000000-0000-4000-8000-000000000004',
  trip_id: '10000000-0000-4000-8000-000000000005',
  owner_membership_id: '10000000-0000-4000-8000-000000000006',
};

function setup(
  accessResult:
    { membershipId: string; role: 'OWNER' | 'MEMBER'; state: 'ACTIVE' | 'ARCHIVED' } | Error,
) {
  let claimed = false;
  const repository = {
    failExhaustedLeases: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn().mockImplementation(async () => {
      if (claimed) return undefined;
      claimed = true;
      return candidate;
    }),
    retry: vi.fn().mockResolvedValue('RETRY'),
    applyAccessLoss: vi.fn().mockResolvedValue('SUPPRESSED'),
    completeNotification: vi.fn().mockResolvedValue('NOTIFIED'),
  };
  const access = {
    get: vi.fn().mockImplementation(async () => {
      if (accessResult instanceof Error) throw accessResult;
      return accessResult;
    }),
  };
  const config = new ConfigService({
    PRICE_WATCH_WORKER_ENABLED: 'false',
    PRICE_WATCH_WORKER_POLL_MS: '100',
    PRICE_WATCH_ATTEMPT_LEASE_MS: '1000',
    PRICE_WATCH_WORKER_BATCH_SIZE: '2',
  });
  const service = new PriceAlertService(config, repository as never, access as never);
  return { service, repository, access };
}

describe('Price Alert worker', () => {
  it('creates the notification only for the current active membership', async () => {
    const { service, repository } = setup({
      membershipId: candidate.owner_membership_id,
      role: 'MEMBER',
      state: 'ACTIVE',
    });
    await service.runCycle();
    expect(repository.completeNotification).toHaveBeenCalledWith(
      expect.stringMatching(/^price-alert:/),
      candidate,
      candidate.owner_membership_id,
    );
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it('retries a dependency outage without consuming the alert', async () => {
    const { service, repository } = setup(new PriceWatchError('SERVICE_UNAVAILABLE'));
    await service.runCycle();
    expect(repository.retry).toHaveBeenCalledWith(
      expect.stringMatching(/^price-alert:/),
      candidate,
      'TRIP_ACCESS_UNAVAILABLE',
    );
    expect(repository.completeNotification).not.toHaveBeenCalled();
  });

  it('suppresses and pauses an alert when the Trip is archived', async () => {
    const { service, repository } = setup({
      membershipId: candidate.owner_membership_id,
      role: 'MEMBER',
      state: 'ARCHIVED',
    });
    await service.runCycle();
    expect(repository.applyAccessLoss).toHaveBeenCalledWith(
      expect.stringMatching(/^price-alert:/),
      candidate,
      'TRIP_ARCHIVED',
    );
  });

  it.each([new PriceWatchError('RESOURCE_NOT_FOUND'), new PriceWatchError('PERMISSION_DENIED')])(
    'stops delivery after terminal access loss',
    async (error) => {
      const { service, repository } = setup(error);
      await service.runCycle();
      expect(repository.applyAccessLoss).toHaveBeenCalledWith(
        expect.stringMatching(/^price-alert:/),
        candidate,
        'ACCESS_REVOKED',
      );
    },
  );

  it('rejects a rejoined membership with the same user id', async () => {
    const { service, repository } = setup({
      membershipId: '20000000-0000-4000-8000-000000000006',
      role: 'MEMBER',
      state: 'ACTIVE',
    });
    await service.runCycle();
    expect(repository.applyAccessLoss).toHaveBeenCalledWith(
      expect.stringMatching(/^price-alert:/),
      candidate,
      'ACCESS_REVOKED',
    );
  });

  it('leaves the lease for recovery when the local finalize fails', async () => {
    const { service, repository } = setup({
      membershipId: candidate.owner_membership_id,
      role: 'MEMBER',
      state: 'ACTIVE',
    });
    repository.completeNotification.mockRejectedValueOnce(new Error('DB_DOWN'));
    await expect(service.runCycle()).rejects.toThrow('DB_DOWN');
    expect(repository.retry).not.toHaveBeenCalled();
  });
});
