import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { createHash } from 'node:crypto';

/** Rough Vietnam bounding box (mainland + near-shore islands covered by the OSRM extract). */
export const VIETNAM_BBOX = Object.freeze({ minLat: 8, maxLat: 23.5, minLon: 102, maxLon: 110 });
export const ROUTE_TTL_MS = 7 * 86400000;
const MAX_GEOMETRY_POINTS = 4000;
const ESTIMATED = 'ESTIMATED_BY_CAR_PROFILE';
type Point = { latitude: number; longitude: number };
type RouteData = { distance_m: number; duration_seconds: number; geometry: Point[] };
type Cached = { payload: RouteData | null; fetched_at: Date; expires_at: Date; status: string };

export function normalizeRoute(request: TravelV1.GetRouteRequest) {
  const raw = request.coordinates ?? [];
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 25)
    throw new Error('VALIDATION_FAILED');
  const points = raw.map((c) => {
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
    return { latitude: Number(latitude.toFixed(5)), longitude: Number(longitude.toFixed(5)) };
  });
  const mode = request.mode ?? TravelV1.RouteMode.ROUTE_MODE_UNSPECIFIED;
  const known = [
    TravelV1.RouteMode.ROUTE_MODE_UNSPECIFIED,
    TravelV1.RouteMode.ROUTE_MODE_DRIVING,
    TravelV1.RouteMode.ROUTE_MODE_WALKING,
    TravelV1.RouteMode.ROUTE_MODE_CYCLING,
  ] as unknown[];
  if (!known.includes(mode)) throw new Error('VALIDATION_FAILED');
  // Only the car profile is preprocessed; UNSPECIFIED means DRIVING.
  const driving =
    mode === TravelV1.RouteMode.ROUTE_MODE_UNSPECIFIED ||
    mode === TravelV1.RouteMode.ROUTE_MODE_DRIVING;
  return { points, driving };
}

/** OSRM `route` response → distance, duration and [lat,lon] geometry (decimated if huge). */
export function osrmRoute(payload: unknown): RouteData | null {
  const body = payload as {
    code?: unknown;
    routes?: { distance?: unknown; duration?: unknown; geometry?: { coordinates?: unknown } }[];
  };
  if (!body || typeof body !== 'object') throw new Error('PROVIDER_RESPONSE_INVALID');
  if (body.code === 'NoRoute' || body.code === 'NoSegment') return null;
  const route = body.code === 'Ok' && Array.isArray(body.routes) ? body.routes[0] : undefined;
  const coordinates = route?.geometry?.coordinates;
  if (
    !route ||
    typeof route.distance !== 'number' ||
    typeof route.duration !== 'number' ||
    !Number.isFinite(route.distance) ||
    !Number.isFinite(route.duration) ||
    !Array.isArray(coordinates)
  )
    throw new Error('PROVIDER_RESPONSE_INVALID');
  const geometry = coordinates.flatMap((pair: unknown) =>
    Array.isArray(pair) &&
    typeof pair[0] === 'number' &&
    typeof pair[1] === 'number' &&
    Number.isFinite(pair[0]) &&
    Number.isFinite(pair[1])
      ? [{ latitude: pair[1], longitude: pair[0] }]
      : [],
  );
  if (geometry.length < 2) throw new Error('PROVIDER_RESPONSE_INVALID');
  const step = Math.ceil(geometry.length / MAX_GEOMETRY_POINTS);
  const thinned =
    step > 1 ? geometry.filter((_, i) => i % step === 0 || i === geometry.length - 1) : geometry;
  return {
    distance_m: Math.round(route.distance),
    duration_seconds: Math.round(route.duration),
    geometry: thinned,
  };
}

@Injectable()
export class RouteService {
  constructor(
    private readonly database: DatabaseProvider,
    private readonly config: ConfigService,
  ) {}

  async route(request: TravelV1.GetRouteRequest): Promise<TravelV1.GetRouteResponse> {
    const { points, driving } = normalizeRoute(request);
    if (!driving) return this.failure('PROVIDER_NOT_CONFIGURED');
    const key = createHash('sha256')
      .update(
        JSON.stringify({ mode: 'DRIVING', points: points.map((p) => [p.latitude, p.longitude]) }),
      )
      .digest('hex');
    const cached = (
      await this.database.query<Cached>(
        "SELECT payload,fetched_at,expires_at,status FROM provider_cache WHERE provider='OSRM' AND data_type='ROUTE' AND canonical_key=$1",
        [key],
      )
    ).rows[0];
    if (cached && cached.expires_at > new Date())
      return this.success(cached.payload, cached.fetched_at, false);
    try {
      const base = this.config.get<string>('OSRM_URL')?.trim();
      if (!base) throw new Error('PROVIDER_NOT_CONFIGURED');
      const url = new URL(
        `route/v1/driving/${points.map((p) => `${p.longitude},${p.latitude}`).join(';')}`,
        base.endsWith('/') ? base : `${base}/`,
      );
      url.searchParams.set('overview', 'full');
      url.searchParams.set('geometries', 'geojson');
      const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
      // OSRM answers 400 with a JSON code for unroutable input (NoRoute/NoSegment).
      if (!response.ok && response.status !== 400) throw new Error('PROVIDER_UNAVAILABLE');
      const data = osrmRoute(await response.json());
      const fetched = new Date();
      await this.database.query(
        `INSERT INTO provider_cache(provider,data_type,canonical_key,payload,status,fetched_at,expires_at)
        VALUES('OSRM','ROUTE',$1,$2::jsonb,$3,$4,$5) ON CONFLICT(provider,data_type,canonical_key) DO UPDATE
        SET payload=EXCLUDED.payload,status=EXCLUDED.status,error_code=NULL,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at,updated_at=now()`,
        [
          key,
          JSON.stringify(data),
          data ? 'SUCCESS' : 'NO_RESULT',
          fetched,
          new Date(fetched.getTime() + ROUTE_TTL_MS),
        ],
      );
      return this.success(data, fetched, false);
    } catch (error) {
      const code =
        error instanceof Error && /^PROVIDER_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'PROVIDER_UNAVAILABLE';
      // An expired cached road route is still better than a straight line; label it stale.
      if (cached?.payload) return this.success(cached.payload, cached.fetched_at, true, code);
      return this.failure(code);
    }
  }

  private success(
    data: RouteData | null,
    fetched: Date,
    stale: boolean,
    warning?: string,
  ): TravelV1.GetRouteResponse {
    return {
      ...(data ? { data } : {}),
      meta: {
        status: data
          ? TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS
          : TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
        provider: 'OSRM',
        fetched_at: { seconds: String(Math.floor(fetched.getTime() / 1000)), nanos: 0 },
        stale,
        is_mock: false,
        warnings: [ESTIMATED, ...(warning ? [warning] : [])],
      },
    };
  }
  private failure(code: string): TravelV1.GetRouteResponse {
    return {
      meta: {
        status: TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR,
        provider: 'OSRM',
        stale: false,
        is_mock: false,
        warnings: [code],
      },
    };
  }
}
