import { describe, expect, it, vi } from 'vitest';
import { PriceWatchService } from './price-watch.service';
import type { PriceWatchRecord } from './price-watch.repository';

const userId = '11111111-1111-4111-8111-111111111111';
const tripId = '22222222-2222-4222-8222-222222222222';
const membershipId = '33333333-3333-4333-8333-333333333333';
const watchId = '44444444-4444-4444-8444-444444444444';

function watch(overrides: Partial<PriceWatchRecord> = {}): PriceWatchRecord {
  return {
    id: watchId,
    query_group_id: '55555555-5555-4555-8555-555555555555',
    user_id: userId,
    trip_id: tripId,
    owner_membership_id: membershipId,
    threshold_price: '2000000',
    currency: 'VND',
    status: 'ACTIVE',
    status_reason: null,
    version: 1,
    expires_at: '2099-11-01T02:00:00.000Z',
    last_alert_price: null,
    last_alert_at: null,
    created_at: '2026-10-22T00:00:00.000Z',
    updated_at: '2026-10-22T00:00:00.000Z',
    client_request_id: '66666666-6666-4666-8666-666666666666',
    request_hash: 'hash',
    canonical_key: 'canonical',
    query: {
      provider: 'MOCK_FLIGHT',
      transport_type: 'FLIGHT',
      origin: 'DAD',
      destination: 'SGN',
      departure_date: '2099-11-01',
      return_date: null,
      journey_type: 'ONE_WAY',
      adults: 1,
      children: 0,
      infants: 0,
      passenger_count: 1,
      cabin_class: 'ECONOMY',
      currency: 'VND',
      departure_at: '2099-11-01T02:00:00.000Z',
    },
    ...overrides,
  };
}

function setup(
  options: {
    state?: 'ACTIVE' | 'ARCHIVED';
    role?: 'OWNER' | 'MEMBER';
    member?: string;
    config?: Record<string, string>;
  } = {},
) {
  const access = {
    get: vi.fn().mockResolvedValue({
      membershipId: options.member ?? membershipId,
      role: options.role ?? 'MEMBER',
      state: options.state ?? 'ACTIVE',
    }),
  };
  const repository = {
    find: vi.fn().mockResolvedValue(watch()),
    create: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    listObservations: vi.fn(),
    changeStatus: vi.fn(
      async (
        _id: string,
        _version: number,
        status: PriceWatchRecord['status'],
        reason: string | null,
        authorize: (row: PriceWatchRecord) => void,
      ) => {
        const row = watch();
        authorize(row);
        return { ...row, status, status_reason: reason, version: 2 };
      },
    ),
  };
  const service = new PriceWatchService(
    {
      get: (key: string) =>
        key === 'AUTOMATION_CURSOR_SECRET' ? 's'.repeat(32) : options.config?.[key],
    } as never,
    access as never,
    repository as never,
  );
  return { service, access, repository };
}

describe('PriceWatchService source selection', () => {
  const request = {
    actor_user_id: userId,
    trip_id: tripId,
    client_request_id: watch().client_request_id,
    watch: {
      origin: 'DAD',
      destination: 'SGN',
      departure_date: '2099-11-01',
      journey_type: 1,
      passengers: { adults: 1 },
      currency: 'VND',
      threshold_price: '2000000',
      departure_at: { seconds: String(Date.parse('2099-11-01T02:00:00Z') / 1000), nanos: 0 },
    },
  } as Parameters<PriceWatchService['create']>[0];

  it('uses the configured real provider when mobile omits it', async () => {
    const { service, repository } = setup({
      config: {
        NODE_ENV: 'production',
        PRICE_WATCH_PROVIDER: 'TRAVELPAYOUTS_CACHE',
        PRICE_WATCH_WORKER_ENABLED: 'true',
        TRAVELPAYOUTS_TOKEN: 'test-provider-token',
        TRAVELPAYOUTS_VND_VERIFIED: 'true',
      },
    });
    await service.create(request, 'c');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          query: expect.objectContaining({ provider: 'TRAVELPAYOUTS_CACHE' }),
        }),
      }),
    );
  });

  it('reports an unavailable source on production without provider credentials', async () => {
    const { service, repository } = setup({ config: { NODE_ENV: 'production' } });
    await expect(service.create(request, 'c')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('PriceWatchService authorization', () => {
  it('allows current members to read archived Trip watches', async () => {
    const { service, repository } = setup({ state: 'ARCHIVED' });
    repository.list.mockResolvedValue([watch()]);
    await expect(
      service.list({ actor_user_id: userId, trip_id: tripId, limit: 20 }, 'c'),
    ).resolves.toMatchObject({
      items: [{ id: watchId }],
      next_cursor: null,
    });
  });

  it('blocks writes after a Trip is archived', async () => {
    const { service, repository } = setup({ state: 'ARCHIVED' });
    await expect(
      service.changeStatus(
        'PAUSE',
        {
          actor_user_id: userId,
          watch_id: watchId,
          expected_version: 1,
        },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(repository.changeStatus).not.toHaveBeenCalled();
  });

  it('does not transfer creator control to a rejoined membership', async () => {
    const { service } = setup({ member: '77777777-7777-4777-8777-777777777777' });
    await expect(
      service.changeStatus(
        'PAUSE',
        {
          actor_user_id: userId,
          watch_id: watchId,
          expected_version: 1,
        },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('lets the current owner stop another member watch but not pause it', async () => {
    const ownerId = '88888888-8888-4888-8888-888888888888';
    const { service } = setup({ role: 'OWNER', member: ownerId });
    await expect(
      service.changeStatus(
        'STOP',
        {
          actor_user_id: ownerId,
          watch_id: watchId,
          expected_version: 1,
        },
        'c',
      ),
    ).resolves.toMatchObject({ status: 'STOPPED', version: 2 });
    await expect(
      service.changeStatus(
        'PAUSE',
        {
          actor_user_id: ownerId,
          watch_id: watchId,
          expected_version: 1,
        },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('does not permit a stopped watch to resume', async () => {
    const { service, repository } = setup();
    repository.find.mockResolvedValue(watch({ status: 'STOPPED' }));
    await expect(
      service.changeStatus(
        'RESUME',
        {
          actor_user_id: userId,
          watch_id: watchId,
          expected_version: 1,
        },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
});
