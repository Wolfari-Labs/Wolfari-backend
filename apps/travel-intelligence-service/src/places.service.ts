import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { signPlaceSelection, type PlaceSnapshot } from '@wolfari/common';
import { createHash } from 'node:crypto';
import { TravelV1 } from '@wolfari/contracts/grpc';

export const PLACE_CATEGORIES: Record<string, string> = {
  tourism: 'tourism',
  restaurant: 'catering.restaurant',
  cafe: 'catering.cafe',
  accommodation: 'accommodation',
};
const attribution = 'Powered by Geoapify | © OpenStreetMap contributors';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Cached = { payload: PlaceSnapshot[]; fetched_at: Date; expires_at: Date; status: string };
export function normalizePlaceSearch(request: TravelV1.SearchPlacesRequest) {
  const query = request.query?.normalize('NFKC').trim() ?? '';
  const lat = request.coordinates?.latitude,
    lon = request.coordinates?.longitude;
  const radius = request.radius_m ?? 5000;
  const category = request.category || 'tourism';
  if (
    !uuid.test(request.actor_user_id ?? '') ||
    !uuid.test(request.trip_id ?? '') ||
    query.length > 200 ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat!) > 90 ||
    Math.abs(lon!) > 180 ||
    !Number.isInteger(radius) ||
    radius < 100 ||
    radius > 20000 ||
    !Object.hasOwn(PLACE_CATEGORIES, category) ||
    (request.geocode && query.length < 2)
  )
    throw new Error('VALIDATION_FAILED');
  return {
    query,
    latitude: Number(lat!.toFixed(4)),
    longitude: Number(lon!.toFixed(4)),
    radius,
    category,
    geocode: request.geocode === true,
  };
}
export function geoapifyPlaces(payload: unknown, fetchedAt: string): PlaceSnapshot[] {
  if (!payload || typeof payload !== 'object') throw new Error('PROVIDER_RESPONSE_INVALID');
  const source = payload as {
    features?: { properties?: Record<string, unknown> }[];
    results?: Record<string, unknown>[];
  };
  const records = source.features?.map((x) => x.properties) ?? source.results;
  if (!Array.isArray(records)) throw new Error('PROVIDER_RESPONSE_INVALID');
  return records.slice(0, 20).flatMap((p) => {
    if (
      !p ||
      typeof p.place_id !== 'string' ||
      !p.place_id ||
      p.place_id.length > 2048 ||
      typeof p.lat !== 'number' ||
      typeof p.lon !== 'number' ||
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lon) ||
      Math.abs(p.lat) > 90 ||
      Math.abs(p.lon) > 180
    )
      return [];
    const name =
      typeof p.name === 'string'
        ? p.name
        : typeof p.address_line1 === 'string'
          ? p.address_line1
          : p.formatted;
    if (typeof name !== 'string' || !name.trim()) return [];
    return [
      {
        provider: 'GEOAPIFY' as const,
        provider_place_id: p.place_id,
        name: name.slice(0, 255),
        address: typeof p.formatted === 'string' ? p.formatted.slice(0, 1000) : '',
        latitude: p.lat,
        longitude: p.lon,
        categories: Array.isArray(p.categories)
          ? p.categories.filter((c): c is string => typeof c === 'string').slice(0, 20)
          : [],
        fetched_at: fetchedAt,
        attribution,
      },
    ];
  });
}
@Injectable()
export class PlacesService {
  private pending = new Map<
    string,
    Promise<{ rows: PlaceSnapshot[]; fetched: Date; stale: boolean; warning?: string }>
  >();
  constructor(
    private readonly database: DatabaseProvider,
    private readonly config: ConfigService,
  ) {}
  async search(request: TravelV1.SearchPlacesRequest): Promise<TravelV1.SearchPlacesResponse> {
    const query = normalizePlaceSearch(request);
    const key = createHash('sha256').update(JSON.stringify(query)).digest('hex');
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.load(key, query);
      this.pending.set(key, promise);
    }
    let result;
    try {
      result = await promise;
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
    const { rows, fetched, stale, warning } = result;
    const secret = this.config.get<string>('PLACE_SELECTION_SECRET') ?? '';
    if (secret.length < 32)
      return {
        data: [],
        meta: {
          status: TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR,
          provider: 'GEOAPIFY',
          stale: false,
          is_mock: false,
          warnings: ['PROVIDER_NOT_CONFIGURED'],
        },
      };
    return {
      data: rows.map((place) => ({
        id: place.provider_place_id,
        name: place.name,
        address: place.address,
        coordinates: { latitude: place.latitude, longitude: place.longitude },
        opening_hours: [],
        categories: place.categories,
        attribution,
        selection_token: signPlaceSelection(
          {
            actor: request.actor_user_id!,
            trip: request.trip_id!,
            expires: Date.now() + 86400000,
            place,
          },
          secret,
        ),
      })),
      meta: {
        status:
          warning && !rows.length
            ? TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR
            : rows.length
              ? TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS
              : TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
        provider: 'GEOAPIFY',
        fetched_at: { seconds: String(Math.floor(fetched.getTime() / 1000)), nanos: 0 },
        stale,
        is_mock: false,
        warnings: warning ? [warning] : [],
      },
    };
  }
  private async load(key: string, query: ReturnType<typeof normalizePlaceSearch>) {
    const cached = (
      await this.database.query<Cached>(
        "SELECT payload,fetched_at,expires_at,status FROM provider_cache WHERE provider='GEOAPIFY' AND data_type='PLACES' AND canonical_key=$1",
        [key],
      )
    ).rows[0];
    if (cached && cached.expires_at > new Date())
      return { rows: cached.payload, fetched: cached.fetched_at, stale: false };
    try {
      const apiKey = this.config.get<string>('GEOAPIFY_API_KEY');
      if (!apiKey || (this.config.get<string>('PLACE_SELECTION_SECRET')?.length ?? 0) < 32)
        throw new Error('PROVIDER_NOT_CONFIGURED');
      // Atomic persistent daily + 2/s limiter. A restart does not reset the quota.
      const permit = await this.database
        .query(`INSERT INTO provider_usage(provider,usage_day,calls,last_call_at)
        VALUES('GEOAPIFY',(now() AT TIME ZONE 'UTC')::date,1,clock_timestamp()) ON CONFLICT(provider) DO UPDATE
        SET calls=CASE WHEN provider_usage.usage_day=EXCLUDED.usage_day THEN provider_usage.calls+1 ELSE 1 END,
        usage_day=EXCLUDED.usage_day,last_call_at=EXCLUDED.last_call_at
        WHERE (provider_usage.usage_day<>EXCLUDED.usage_day OR provider_usage.calls<1000)
          AND provider_usage.last_call_at<=clock_timestamp()-interval '500 milliseconds' RETURNING calls`);
      if (!permit.rowCount) throw new Error('PROVIDER_RATE_LIMITED');
      const url = new URL(
        query.geocode
          ? 'https://api.geoapify.com/v1/geocode/search'
          : 'https://api.geoapify.com/v2/places',
      );
      url.searchParams.set('apiKey', apiKey);
      url.searchParams.set('limit', '20');
      url.searchParams.set('lang', 'vi');
      if (query.geocode) {
        url.searchParams.set('text', query.query);
        url.searchParams.set('format', 'json');
        url.searchParams.set('bias', `proximity:${query.longitude},${query.latitude}`);
      } else {
        url.searchParams.set('categories', PLACE_CATEGORIES[query.category]!);
        url.searchParams.set(
          'filter',
          `circle:${query.longitude},${query.latitude},${query.radius}`,
        );
        if (query.query) url.searchParams.set('name', query.query);
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? 'PROVIDER_RATE_LIMITED'
            : [401, 403].includes(response.status)
              ? 'PROVIDER_AUTH_FAILED'
              : 'PROVIDER_UNAVAILABLE',
        );
      const fetched = new Date();
      const rows = geoapifyPlaces(await response.json(), fetched.toISOString());
      await this.database.query(
        `INSERT INTO provider_cache(provider,data_type,canonical_key,payload,status,fetched_at,expires_at)
        VALUES('GEOAPIFY','PLACES',$1,$2::jsonb,$3,$4,$5) ON CONFLICT(provider,data_type,canonical_key) DO UPDATE
        SET payload=EXCLUDED.payload,status=EXCLUDED.status,error_code=NULL,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at,updated_at=now()`,
        [
          key,
          JSON.stringify(rows),
          rows.length ? 'SUCCESS' : 'NO_RESULT',
          fetched,
          new Date(fetched.getTime() + (rows.length ? 86400000 : 300000)),
        ],
      );
      return { rows, fetched, stale: false };
    } catch (error) {
      const code =
        error instanceof Error && /^PROVIDER_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'PROVIDER_UNAVAILABLE';
      const usable = cached && cached.fetched_at.getTime() > Date.now() - 7 * 86400000;
      return {
        rows: usable ? cached.payload : [],
        fetched: usable ? cached.fetched_at : new Date(),
        stale: Boolean(usable),
        warning: code,
      };
    }
  }
}
