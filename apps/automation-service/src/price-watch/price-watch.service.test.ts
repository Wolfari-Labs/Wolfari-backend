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

  it.each([
    { NODE_ENV: 'production', PRICE_WATCH_PROVIDER: 'TRAVELPAYOUTS_CACHE' },
    { NODE_ENV: 'development', PRICE_WATCH_PROVIDER: '' },
  ])('selects the real provider when mobile omits it in $NODE_ENV', async (deployment) => {
    const { service, repository } = setup({
      config: {
        ...deployment,
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

  it('requires VND verification before creating a watch with a local token', async () => {
    const { service, repository } = setup({
      config: { TRAVELPAYOUTS_TOKEN: 'test-token', PRICE_WATCH_WORKER_ENABLED: 'true' },
    });
    await expect(service.create(request, 'c')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'PRICE_PROVIDER_NOT_CONFIGURED' },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('creates a SearchApi watch with an enabled worker and a key', async () => {
    const { service, repository } = setup({
      config: {
        PRICE_WATCH_PROVIDER: 'SEARCHAPI_GOOGLE_FLIGHTS',
        SEARCHAPI_API_KEY: 'test-key',
        PRICE_WATCH_WORKER_ENABLED: 'true',
      },
    });
    await service.create(request, 'c');
    expect(repository.create.mock.calls[0]?.[0]).toMatchObject({
      value: { query: { provider: 'SEARCHAPI_GOOGLE_FLIGHTS' } },
    });
  });

  it('reports an unavailable source on production without provider credentials', async () => {
    const { service, repository } = setup({ config: { NODE_ENV: 'production' } });
    await expect(service.create(request, 'c')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('PriceWatchService capabilities', () => {
  it('describes the configured real source and whether a watch can be created now', () => {
    const live = setup({
      config: {
        PRICE_WATCH_PROVIDER: 'SEARCHAPI_GOOGLE_FLIGHTS',
        SEARCHAPI_API_KEY: 'test-key',
        PRICE_WATCH_WORKER_ENABLED: 'true',
      },
    }).service.capabilities({ actor_user_id: userId });
    expect(live).toEqual({
      provider: 'SEARCHAPI_GOOGLE_FLIGHTS',
      available: true,
      journey_types: ['ONE_WAY'],
      cabin_classes: ['ECONOMY'],
      max_adults: 1,
      max_children: 0,
      max_infants: 0,
      max_passengers: 1,
      currencies: ['VND'],
    });
    const stopped = setup({
      config: { PRICE_WATCH_PROVIDER: 'SEARCHAPI_GOOGLE_FLIGHTS', SEARCHAPI_API_KEY: 'test-key' },
    }).service.capabilities({ actor_user_id: userId });
    expect(stopped).toMatchObject({ provider: 'SEARCHAPI_GOOGLE_FLIGHTS', available: false });
    const production = setup({ config: { NODE_ENV: 'production' } }).service.capabilities({
      actor_user_id: userId,
    });
    expect(production).toMatchObject({ provider: 'TRAVELPAYOUTS_CACHE', available: false });
  });

  it('offers every combination only for the development mock', () => {
    const mock = setup({ config: { NODE_ENV: 'development' } }).service.capabilities({
      actor_user_id: userId,
    });
    expect(mock).toMatchObject({
      provider: 'MOCK_FLIGHT',
      available: true,
      journey_types: ['ONE_WAY', 'ROUND_TRIP'],
      cabin_classes: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'],
      max_passengers: 9,
    });
    expect(() =>
      setup().service.capabilities({ actor_user_id: 'not-a-uuid' }),
    ).toThrowError('VALIDATION_FAILED');
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

describe('PriceWatchService provider selection', () => {
  const write = (overrides: Record<string, unknown> = {}) => ({
    provider: '',
    origin: 'SGN',
    destination: 'HAN',
    departure_date: '2099-12-14',
    journey_type: 1,
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin_class: 'ECONOMY',
    currency: 'VND',
    threshold_price: '1500000',
    departure_at: { seconds: String(Date.parse('2099-12-14T02:00:00Z') / 1000), nanos: 0 },
    ...overrides,
  });
  const create = (config: Record<string, string>, overrides: Record<string, unknown> = {}) => {
    const access = {
      get: vi.fn().mockResolvedValue({ membershipId, role: 'MEMBER', state: 'ACTIVE' }),
    };
    const repository = { create: vi.fn(async (input: unknown) => input) };
    const service = new PriceWatchService(
      {
        get: (key: string) =>
          config[key] ?? (key === 'AUTOMATION_CURSOR_SECRET' ? 's'.repeat(32) : undefined),
      } as never,
      access as never,
      repository as never,
    );
    return {
      repository,
      run: () =>
        service.create(
          {
            actor_user_id: userId,
            trip_id: tripId,
            client_request_id: '66666666-6666-4666-8666-666666666666',
            watch: write(overrides) as never,
          },
          'c',
        ),
    };
  };
  const live = {
    PRICE_WATCH_PROVIDER: 'TRAVELPAYOUTS_CACHE',
    PRICE_WATCH_WORKER_ENABLED: 'true',
    TRAVELPAYOUTS_TOKEN: 'unit-only-token',
    TRAVELPAYOUTS_VND_VERIFIED: 'true',
  };

  it('uses the configured real provider when the client omits it', async () => {
    const { run, repository } = create(live);
    await run();
    expect(repository.create.mock.calls[0]![0]).toMatchObject({
      value: { query: { provider: 'TRAVELPAYOUTS_CACHE', origin: 'SGN', destination: 'HAN' } },
    });
  });

  it('falls back to MOCK_FLIGHT outside production when no real provider is configured', async () => {
    const { run, repository } = create({});
    await run();
    expect(repository.create.mock.calls[0]![0]).toMatchObject({
      value: { query: { provider: 'MOCK_FLIGHT' } },
    });
  });

  it('explains a query the real provider cannot price', async () => {
    const { run, repository } = create(live, {
      journey_type: 2,
      return_date: '2099-12-20',
    });
    await expect(run()).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'PROVIDER_QUERY_UNSUPPORTED' },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('reports a real provider that is selected but not configured', async () => {
    const { run } = create({ ...live, TRAVELPAYOUTS_TOKEN: '' });
    await expect(run()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'PRICE_PROVIDER_NOT_CONFIGURED' },
    });
  });
});
