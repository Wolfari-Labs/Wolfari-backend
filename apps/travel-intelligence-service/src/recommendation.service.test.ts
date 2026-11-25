import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Metadata } from '@grpc/grpc-js';
import type { DatabaseProvider } from '@wolfari/database';
import { TravelV1, TripV1 } from '@wolfari/contracts/grpc';
import { dayPoints, RecommendationService, thresholdsFrom } from './recommendation.service';
import { RecommendationController } from './recommendation.grpc';
import { WeatherService, type WeatherLookup } from './weather.service';

const ts = (iso: string) => ({ seconds: String(Date.parse(iso) / 1000), nanos: 0 });
const now = new Date('2026-11-25T03:00:00Z');
const plan: TripV1.PlanSnapshot = {
  trip_id: '11111111-1111-4111-8111-111111111111',
  plan_version: 10,
  timezone: 'Asia/Ho_Chi_Minh',
  start_at: ts('2026-11-26T00:00:00+07:00'),
  end_at: ts('2026-11-28T00:00:00+07:00'),
  selected_locations: [
    { id: 'l1', name: 'Mỹ Khê', coordinates: { latitude: 16.0612, longitude: 108.2465 } },
    { id: 'l2', name: 'Hội An', coordinates: { latitude: 15.8801, longitude: 108.338 } },
  ],
  activities: [
    {
      id: 'a1',
      title: 'Tắm biển',
      activity_type: 'BEACH',
      starts_at: ts('2026-11-26T08:00:00+07:00'),
      selected_location_id: 'l1',
      position: 0,
    },
    {
      id: 'a2',
      title: 'Phố cổ',
      activity_type: 'WALKING',
      starts_at: ts('2026-11-27T09:00:00+07:00'),
      selected_location_id: 'l2',
      position: 1,
    },
  ],
  dress_codes: [],
  packing_items: [],
};
const lookup = (rain: number): WeatherLookup => ({
  days: new Map(
    ['2026-11-26', '2026-11-27'].map((date) => [
      date,
      { date, temperature_max_c: 28, temperature_min_c: 22, rain_probability: rain, uv_index: 7 },
    ]),
  ),
  fetched_at: now,
  stale: false,
  is_mock: false,
  provider: 'OPEN_METEO',
});
const make = (config?: unknown) => {
  const db = {
    query: vi.fn(async () => ({ rows: config === undefined ? [] : [{ enabled: true, config }] })),
  };
  const weather = new WeatherService(db as unknown as DatabaseProvider, new ConfigService({}));
  const spy = vi.spyOn(weather, 'lookup').mockResolvedValue(lookup(0.7));
  return { svc: new RecommendationService(db as unknown as DatabaseProvider, weather), spy };
};

describe('weather points', () => {
  it('uses the first located stop of each day, rounded', () =>
    expect([...dayPoints(plan)]).toEqual([
      ['2026-11-26', { latitude: 16.06, longitude: 108.25 }],
      ['2026-11-27', { latitude: 15.88, longitude: 108.34 }],
    ]));
});

describe('thresholds', () => {
  it('falls back to SRS defaults for missing or absurd values', () =>
    expect(thresholdsFrom({ coldMaxC: 15, uvMin: 'x', walkingPerDay: 99 })).toEqual({
      coldMaxC: 15,
      uvMin: 6,
      walkingPerDay: 2,
    }));
});

describe('RecommendationService', () => {
  it('looks up one forecast per point and returns proposals, rule version, hash and sources', async () => {
    const { svc, spy } = make();
    const res = await svc.recommend({ plan, type: 'ALL' }, now);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.rule_version).toMatch(/^dss-/);
    expect(res.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.proposal?.map((p) => p.packing_item?.name ?? p.dress_code?.label)).toEqual([
      'Ô',
      'Áo mưa',
      'Kem chống nắng',
      'Đồ bơi',
      'Đồ đi biển',
    ]);
    expect(res.proposal?.[0]).toMatchObject({
      reason: 'Ngày 26/11 khả năng mưa 70%\nNgày 27/11 khả năng mưa 70%',
      rule_ids: ['PK-RAIN'],
    });
    expect(res.proposal?.[0]?.packing_item?.source).toBe(TripV1.EntitySource.ENTITY_SOURCE_DSS);
    expect(res.provider_sources?.[0]).toMatchObject({
      provider: 'OPEN_METEO',
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS,
    });
  });
  it('changes the hash when the weather changes, so a stale preview is detectable', async () => {
    const a = make();
    const first = await a.svc.recommend({ plan, type: 'PACKING' }, now);
    a.spy.mockResolvedValue(lookup(0.2));
    const second = await a.svc.recommend({ plan, type: 'PACKING' }, now);
    expect(first.input_hash).not.toBe(second.input_hash);
  });
  it('applies admin thresholds', async () => {
    const res = await make({ uvMin: 9 }).svc.recommend({ plan, type: 'PACKING' }, now);
    expect(res.proposal?.map((p) => p.packing_item?.name)).not.toContain('Kem chống nắng');
  });
  it('warns instead of guessing for days past the forecast window', async () => {
    const far = {
      ...plan,
      start_at: ts('2027-01-10T00:00:00+07:00'),
      end_at: ts('2027-01-11T00:00:00+07:00'),
      activities: [],
    };
    const { svc, spy } = make();
    const res = await svc.recommend({ plan: far, type: 'PACKING' }, now);
    expect(spy).not.toHaveBeenCalled();
    expect(res.warnings).toEqual(['WEATHER_UNAVAILABLE', 'FORECAST_OUT_OF_RANGE']);
  });
  it('rejects an unknown type', async () =>
    expect(make().svc.recommend({ plan, type: 'EVERYTHING' }, now)).rejects.toThrow(
      'VALIDATION_FAILED',
    ));
});

describe('RecommendationController', () => {
  const config = new ConfigService({
    GATEWAY_TRAVEL_SECRET: 'g'.repeat(64),
    TRIP_TRAVEL_SECRET: 't'.repeat(64),
  });
  const meta = (caller: string, secret: string) => {
    const m = new Metadata();
    m.set('x-caller-service', caller);
    m.set('x-service-secret', secret);
    return m;
  };
  it('accepts Trip with its own secret and refuses the gateway', async () => {
    const svc = {
      recommend: vi.fn(async () => ({ proposal: [] })),
    } as unknown as RecommendationService;
    const controller = new RecommendationController(svc, config);
    await expect(
      controller.getRecommendation({ plan, type: 'ALL' }, meta('Trip', 't'.repeat(64))),
    ).resolves.toEqual({ proposal: [] });
    await expect(
      controller.getRecommendation({ plan, type: 'ALL' }, meta('ApiGateway', 'g'.repeat(64))),
    ).rejects.toMatchObject({ error: { message: 'Caller is not authorized' } });
    await expect(
      controller.getRecommendation({ plan, type: 'ALL' }, meta('Trip', 'g'.repeat(64))),
    ).rejects.toBeTruthy();
  });
});
