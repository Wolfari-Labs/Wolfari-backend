import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import { TravelV1 } from '@wolfari/contracts/grpc';
import {
  WeatherService,
  inForecastRange,
  mockDay,
  normalizeWeather,
  openMeteoDaily,
  WEATHER_TTL_MS,
} from './weather.service';

const daNang = { latitude: 16.054407, longitude: 108.202167 };
const now = new Date('2026-11-25T03:00:00Z'); // 10:00 in Vietnam
const body = {
  daily: {
    time: ['2026-11-25', '2026-11-26', '2026-11-27'],
    temperature_2m_max: [27.04, 25.5, 24],
    temperature_2m_min: [21.3, 20.1, null],
    precipitation_probability_max: [60, 10, 90],
    uv_index_max: [8.25, null, 5],
  },
};
afterEach(() => vi.unstubAllGlobals());

const service = (
  opts: {
    cached?: Record<string, unknown>;
    config?: Record<string, string>;
    permit?: boolean;
  } = {},
) => {
  const db = {
    query: vi.fn(async (sql: string) =>
      sql.startsWith('SELECT')
        ? { rows: opts.cached ? [opts.cached] : [] }
        : sql.includes('provider_usage')
          ? { rows: [{ calls: 1 }], rowCount: opts.permit === false ? 0 : 1 }
          : { rows: [], rowCount: 1 },
    ),
  };
  return {
    db,
    svc: new WeatherService(
      db as unknown as DatabaseProvider,
      new ConfigService(opts.config ?? {}),
    ),
  };
};
const ok = (json: unknown, status = 200) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => json }));

describe('weather input', () => {
  it.each([
    { coordinate: daNang, date: '25/11/2026' },
    { coordinate: daNang, date: '2026-13-40' },
    { coordinate: { latitude: 48.85, longitude: 2.35 }, date: '2026-11-25' },
    { coordinate: { latitude: Number.NaN, longitude: 108 }, date: '2026-11-25' },
    { date: '2026-11-25' },
  ])('rejects %j', (request) =>
    expect(() => normalizeWeather(request as TravelV1.GetWeatherRequest)).toThrow(
      'VALIDATION_FAILED',
    ),
  );
  it('rounds the point to two decimals so nearby stops share a forecast', () =>
    expect(normalizeWeather({ coordinate: daNang, date: '2026-11-25' }).point).toEqual({
      latitude: 16.05,
      longitude: 108.2,
    }));
  it('accepts today to today + 15 in Vietnam time only', () => {
    expect(inForecastRange('2026-11-25', now)).toBe(true);
    expect(inForecastRange('2026-12-10', now)).toBe(true);
    expect(inForecastRange('2026-12-11', now)).toBe(false);
    expect(inForecastRange('2026-11-24', now)).toBe(false);
  });
});

describe('Open-Meteo parsing', () => {
  it('keeps complete days, converts % to 0..1 and leaves UV out when missing', () =>
    expect(openMeteoDaily(body)).toEqual([
      {
        date: '2026-11-25',
        temperature_max_c: 27,
        temperature_min_c: 21.3,
        rain_probability: 0.6,
        uv_index: 8.3,
      },
      {
        date: '2026-11-26',
        temperature_max_c: 25.5,
        temperature_min_c: 20.1,
        rain_probability: 0.1,
      },
    ]));
  it('rejects a body without daily data', () =>
    expect(() => openMeteoDaily({ hourly: {} })).toThrow('PROVIDER_RESPONSE_INVALID'));
});

describe('WeatherService', () => {
  it('fetches the 16-day series once, caches it for 3 hours and credits Open-Meteo', async () => {
    const fetch = ok(body);
    vi.stubGlobal('fetch', fetch);
    const { db, svc } = service();
    const res = await svc.weather({ coordinate: daNang, date: '2026-11-25' }, now);
    expect(res.data).toMatchObject({
      temperature_c: 27,
      temperature_min_c: 21.3,
      rain_probability: 0.6,
      uv_index: 8.3,
    });
    expect(res.meta).toMatchObject({
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS,
      provider: 'OPEN_METEO',
      stale: false,
      is_mock: false,
    });
    expect(res.meta?.attribution?.[0]?.url).toBe('https://open-meteo.com/');
    const url = new URL(String((fetch.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('forecast_days')).toBe('16');
    expect(url.searchParams.get('latitude')).toBe('16.05');
    const insert = db.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO provider_cache'),
    );
    const [, params] = insert as unknown as [string, unknown[]];
    expect((params[4] as Date).getTime() - (params[3] as Date).getTime()).toBe(WEATHER_TTL_MS);
  });
  it('serves a fresh cache row without calling the provider', async () => {
    const fetch = ok(body);
    vi.stubGlobal('fetch', fetch);
    const { svc } = service({
      cached: {
        payload: openMeteoDaily(body),
        fetched_at: now,
        expires_at: new Date(now.getTime() + 1000),
      },
    });
    const res = await svc.weather({ coordinate: daNang, date: '2026-11-26' }, now);
    expect(fetch).not.toHaveBeenCalled();
    expect(res.data?.temperature_c).toBe(25.5);
  });
  it('labels an expired forecast stale when the provider fails', async () => {
    vi.stubGlobal('fetch', ok({}, 503));
    const old = new Date(now.getTime() - WEATHER_TTL_MS * 2);
    const { svc } = service({
      cached: {
        payload: openMeteoDaily(body),
        fetched_at: old,
        expires_at: new Date(old.getTime() + WEATHER_TTL_MS),
      },
    });
    const res = await svc.weather({ coordinate: daNang, date: '2026-11-25' }, now);
    expect(res.meta).toMatchObject({ stale: true, warnings: ['PROVIDER_UNAVAILABLE'] });
    expect(res.data?.rain_probability).toBe(0.6);
  });
  it('reports an error without data when nothing is cached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const res = await service().svc.weather({ coordinate: daNang, date: '2026-11-25' }, now);
    expect(res.data).toBeUndefined();
    expect(res.meta).toMatchObject({
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR,
      warnings: ['PROVIDER_UNAVAILABLE'],
    });
  });
  it('stops calling once the daily quota is used', async () => {
    const fetch = ok(body);
    vi.stubGlobal('fetch', fetch);
    const res = await service({ permit: false }).svc.weather(
      { coordinate: daNang, date: '2026-11-25' },
      now,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(res.meta?.warnings).toEqual(['PROVIDER_RATE_LIMITED']);
  });
  it('never guesses past the forecast window', async () => {
    const fetch = ok(body);
    vi.stubGlobal('fetch', fetch);
    const res = await service().svc.weather({ coordinate: daNang, date: '2026-12-20' }, now);
    expect(fetch).not.toHaveBeenCalled();
    expect(res.meta).toMatchObject({
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
      warnings: ['FORECAST_OUT_OF_RANGE'],
    });
  });
  it('mock mode is deterministic, offline and always labelled', async () => {
    const fetch = ok(body);
    vi.stubGlobal('fetch', fetch);
    const { db, svc } = service({ config: { TRAVEL_WEATHER_MOCK: 'true' } });
    const a = await svc.weather({ coordinate: daNang, date: '2026-11-27' }, now);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(a.meta).toMatchObject({ is_mock: true, provider: 'MOCK' });
    expect(a.data?.temperature_c).toBe(
      mockDay({ latitude: 16.05, longitude: 108.2 }, '2026-11-27').temperature_max_c,
    );
  });
});
