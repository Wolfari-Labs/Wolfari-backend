import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { createHash } from 'node:crypto';
import { VIETNAM_BBOX } from './route.service';

/**
 * FR-TI01 weather. Open-Meteo's free API (non-commercial, no key, CC BY 4.0 attribution) gives
 * up to 16 days of daily forecast with rain probability and UV, which the DSS rules need.
 * One call fetches every day for a point; the whole series is cached, so a trip's days share it.
 */
export const WEATHER_TTL_MS = 3 * 3600_000;
export const FORECAST_DAYS = 16;
/** Open-Meteo's free tier allows 10,000 calls a day; stay well under it. */
export const DAILY_CALL_LIMIT = 9000;
const PROVIDER = 'OPEN_METEO';
const DEFAULT_URL = 'https://api.open-meteo.com/v1/';
const ATTRIBUTION = [{ text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' }];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DailyWeather = {
  date: string;
  temperature_max_c: number;
  temperature_min_c: number;
  rain_probability: number; // 0..1
  uv_index?: number;
};
type Point = { latitude: number; longitude: number };
type Cached = { payload: DailyWeather[] | null; fetched_at: Date; expires_at: Date };
export type WeatherLookup = {
  days: Map<string, DailyWeather>;
  fetched_at?: Date;
  stale: boolean;
  is_mock: boolean;
  provider: string;
  error?: string;
};

/** Validates a point inside Vietnam and rounds it to ~1 km so nearby stops share a cache row. */
export function normalizePoint(coordinate: unknown): Point {
  const c = coordinate as { latitude?: unknown; longitude?: unknown } | undefined;
  const latitude = c?.latitude,
    longitude = c?.longitude;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < VIETNAM_BBOX.minLat ||
    latitude > VIETNAM_BBOX.maxLat ||
    longitude < VIETNAM_BBOX.minLon ||
    longitude > VIETNAM_BBOX.maxLon
  )
    throw new Error('VALIDATION_FAILED');
  return { latitude: Number(latitude.toFixed(2)), longitude: Number(longitude.toFixed(2)) };
}

export function normalizeWeather(request: TravelV1.GetWeatherRequest) {
  const date = request.date;
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))
    throw new Error('VALIDATION_FAILED');
  return { point: normalizePoint(request.coordinate), date };
}

/** Today's date in Vietnam, as YYYY-MM-DD. */
export function vietnamToday(now = new Date()) {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** True when `date` is inside the provider's forecast window (today .. today + 15). */
export function inForecastRange(date: string, now = new Date()) {
  const today = Date.parse(`${vietnamToday(now)}T00:00:00Z`);
  const day = Date.parse(`${date}T00:00:00Z`);
  return day >= today && day < today + FORECAST_DAYS * 86400000;
}

/** Open-Meteo `daily` arrays → one record per day. Missing values make that day unusable. */
export function openMeteoDaily(payload: unknown): DailyWeather[] {
  const daily = (payload as { daily?: Record<string, unknown> } | null)?.daily;
  if (!daily || typeof daily !== 'object' || !Array.isArray(daily.time))
    throw new Error('PROVIDER_RESPONSE_INVALID');
  const column = (name: string) => (Array.isArray(daily[name]) ? (daily[name] as unknown[]) : []);
  const max = column('temperature_2m_max'),
    min = column('temperature_2m_min'),
    rain = column('precipitation_probability_max'),
    uv = column('uv_index_max');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return (daily.time as unknown[]).flatMap((date, i) => {
    const hi = num(max.at(i)),
      lo = num(min.at(i)),
      pop = num(rain.at(i));
    if (
      typeof date !== 'string' ||
      !DATE.test(date) ||
      hi === undefined ||
      lo === undefined ||
      pop === undefined
    )
      return [];
    const u = num(uv.at(i));
    return [
      {
        date,
        temperature_max_c: Math.round(hi * 10) / 10,
        temperature_min_c: Math.round(lo * 10) / 10,
        rain_probability: Math.min(1, Math.max(0, pop / 100)),
        ...(u === undefined ? {} : { uv_index: Math.round(u * 10) / 10 }),
      },
    ];
  });
}

/** Deterministic test data: same point and date always give the same values. */
export function mockDay(point: Point, date: string): DailyWeather {
  const h = createHash('sha256').update(`${point.latitude},${point.longitude},${date}`).digest();
  return {
    date,
    temperature_max_c: 24 + (h[0] % 10),
    temperature_min_c: 16 + (h[1] % 8),
    rain_probability: (h[2] % 101) / 100,
    uv_index: 3 + (h[3] % 9),
  };
}

const seconds = (d: Date) => ({ seconds: String(Math.floor(d.getTime() / 1000)), nanos: 0 });

@Injectable()
export class WeatherService {
  constructor(
    private readonly database: DatabaseProvider,
    private readonly config: ConfigService,
  ) {}

  private get mock() {
    return this.config.get<string>('TRAVEL_WEATHER_MOCK')?.trim() === 'true';
  }

  /** The cached or freshly fetched daily series for one point. Never throws for provider trouble. */
  async lookup(point: Point, now = new Date()): Promise<WeatherLookup> {
    if (this.mock) {
      const days = new Map<string, DailyWeather>();
      for (let i = 0; i < FORECAST_DAYS; i++) {
        const date = new Date(Date.parse(`${vietnamToday(now)}T00:00:00Z`) + i * 86400000)
          .toISOString()
          .slice(0, 10);
        days.set(date, mockDay(point, date));
      }
      return { days, fetched_at: now, stale: false, is_mock: true, provider: 'MOCK' };
    }
    const key = createHash('sha256')
      .update(JSON.stringify({ v: 1, points: [point.latitude, point.longitude] }))
      .digest('hex');
    const cached = (
      await this.database.query<Cached>(
        `SELECT payload,fetched_at,expires_at FROM provider_cache WHERE provider='${PROVIDER}' AND data_type='WEATHER' AND canonical_key=$1`,
        [key],
      )
    ).rows[0];
    const toMap = (rows: DailyWeather[] | null) => new Map((rows ?? []).map((d) => [d.date, d]));
    if (cached && cached.expires_at > now)
      return {
        days: toMap(cached.payload),
        fetched_at: cached.fetched_at,
        stale: false,
        is_mock: false,
        provider: PROVIDER,
      };
    try {
      const permit = await this.database.query(
        `INSERT INTO provider_usage(provider,usage_day,calls,last_call_at)
        VALUES('${PROVIDER}',(now() AT TIME ZONE 'UTC')::date,1,clock_timestamp()) ON CONFLICT(provider) DO UPDATE
        SET calls=CASE WHEN provider_usage.usage_day=EXCLUDED.usage_day THEN provider_usage.calls+1 ELSE 1 END,
        usage_day=EXCLUDED.usage_day,last_call_at=EXCLUDED.last_call_at
        WHERE provider_usage.usage_day<>EXCLUDED.usage_day OR provider_usage.calls<${DAILY_CALL_LIMIT} RETURNING calls`,
      );
      if (!permit.rowCount) throw new Error('PROVIDER_RATE_LIMITED');
      const base = this.config.get<string>('OPEN_METEO_URL')?.trim() || DEFAULT_URL;
      const url = new URL('forecast', base.endsWith('/') ? base : `${base}/`);
      url.searchParams.set('latitude', String(point.latitude));
      url.searchParams.set('longitude', String(point.longitude));
      url.searchParams.set(
        'daily',
        'temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max',
      );
      url.searchParams.set('timezone', 'Asia/Ho_Chi_Minh');
      url.searchParams.set('forecast_days', String(FORECAST_DAYS));
      const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
      if (response.status === 429) throw new Error('PROVIDER_RATE_LIMITED');
      if (!response.ok) throw new Error('PROVIDER_UNAVAILABLE');
      const days = openMeteoDaily(await response.json());
      const fetched = new Date();
      await this.database.query(
        `INSERT INTO provider_cache(provider,data_type,canonical_key,payload,status,fetched_at,expires_at)
        VALUES('${PROVIDER}','WEATHER',$1,$2::jsonb,$3,$4,$5) ON CONFLICT(provider,data_type,canonical_key) DO UPDATE
        SET payload=EXCLUDED.payload,status=EXCLUDED.status,error_code=NULL,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at,updated_at=now()`,
        [
          key,
          JSON.stringify(days),
          days.length ? 'SUCCESS' : 'NO_RESULT',
          fetched,
          new Date(fetched.getTime() + WEATHER_TTL_MS),
        ],
      );
      return {
        days: toMap(days),
        fetched_at: fetched,
        stale: false,
        is_mock: false,
        provider: PROVIDER,
      };
    } catch (error) {
      const code =
        error instanceof Error && /^PROVIDER_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'PROVIDER_UNAVAILABLE';
      // An expired forecast is still better than none; it is labelled stale.
      if (cached?.payload)
        return {
          days: toMap(cached.payload),
          fetched_at: cached.fetched_at,
          stale: true,
          is_mock: false,
          provider: PROVIDER,
          error: code,
        };
      return { days: new Map(), stale: false, is_mock: false, provider: PROVIDER, error: code };
    }
  }

  /** Provider metadata for a lookup, shared by GetWeather and the DSS provider_sources. */
  meta(
    found: WeatherLookup,
    status: TravelV1.ProviderStatus,
    warnings: string[] = [],
  ): TravelV1.ProviderMetadata {
    return {
      status,
      provider: found.provider,
      ...(found.fetched_at ? { fetched_at: seconds(found.fetched_at) } : {}),
      stale: found.stale,
      is_mock: found.is_mock,
      warnings: [...warnings, ...(found.error ? [found.error] : [])],
      attribution: found.is_mock ? [] : ATTRIBUTION,
    };
  }

  async weather(
    request: TravelV1.GetWeatherRequest,
    now = new Date(),
  ): Promise<TravelV1.GetWeatherResponse> {
    const { point, date } = normalizeWeather(request);
    if (!inForecastRange(date, now))
      return {
        meta: {
          status: TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
          provider: this.mock ? 'MOCK' : PROVIDER,
          stale: false,
          is_mock: this.mock,
          warnings: ['FORECAST_OUT_OF_RANGE'],
        },
      };
    const found = await this.lookup(point, now);
    const day = found.days.get(date);
    if (!day)
      return {
        meta: this.meta(
          found,
          found.error && !found.stale
            ? TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR
            : TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
        ),
      };
    return {
      data: {
        forecast_at: seconds(new Date(`${date}T00:00:00+07:00`)),
        temperature_c: day.temperature_max_c,
        temperature_min_c: day.temperature_min_c,
        rain_probability: day.rain_probability,
        ...(day.uv_index === undefined ? {} : { uv_index: day.uv_index }),
      },
      meta: this.meta(found, TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS),
    };
  }
}
