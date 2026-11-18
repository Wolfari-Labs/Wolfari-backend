import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import {
  DEFAULT_PLACE_SEARCH_CATEGORIES,
  PLACE_SEARCH_CATEGORIES,
  POI_SEARCH_CATEGORIES,
  poiCategoryGroup,
  poiCategoryLabel,
  signPlaceSelection,
  vnProvinceName,
  type PlaceSearchCategory,
  type PlaceSnapshot,
} from '@wolfari/common';
import { createHash } from 'node:crypto';
import { TravelV1 } from '@wolfari/contracts/grpc';
import {
  DEFAULT_LIMIT,
  GOOD_SIMILARITY,
  MAX_BBOX_DEGREES,
  MAX_LIMIT,
  catalogSnapshot,
  duplicatesCatalog,
  searchCatalog,
  type CatalogPoi,
  type CatalogResult,
} from './poi-catalog';

/** Public search group → Geoapify categories ('' = the group is never sent to Geoapify). */
export const PLACE_CATEGORIES: Record<PlaceSearchCategory, string> = {
  tourism: 'tourism',
  restaurant: 'catering.restaurant',
  cafe: 'catering.cafe',
  accommodation: 'accommodation',
  nightlife: 'catering.bar,catering.pub',
  shopping: 'commercial',
  entertainment: 'entertainment,sport',
  wellness: 'service.beauty',
  transport: 'airport,public_transport',
  services: 'service.financial.atm,healthcare.pharmacy,healthcare.hospital',
  other: '',
};
const attribution = 'Powered by Geoapify | © OpenStreetMap contributors';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Cached = { payload: PlaceSnapshot[]; fetched_at: Date; expires_at: Date; status: string };

/** `category`: '' = default groups, 'all' = every group, otherwise one public group. */
export function placeSearchGroups(category: string): PlaceSearchCategory[] | null {
  if (!category) return [...DEFAULT_PLACE_SEARCH_CATEGORIES];
  if (category === 'all') return [...PLACE_SEARCH_CATEGORIES];
  return (PLACE_SEARCH_CATEGORIES as readonly string[]).includes(category)
    ? [category as PlaceSearchCategory]
    : null;
}
/** Map frame validation shared with the gateway: finite, ordered, at most 2° per side. */
export function bboxProblem(
  b: Partial<TravelV1.BoundingBox>,
): 'INVALID_BBOX' | 'BBOX_TOO_LARGE' | null {
  const values = [b.min_longitude, b.min_latitude, b.max_longitude, b.max_latitude];
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return 'INVALID_BBOX';
  const [minLon, minLat, maxLon, maxLat] = values as number[];
  if (minLon! < -180 || maxLon! > 180 || minLat! < -90 || maxLat! > 90) return 'INVALID_BBOX';
  if (minLon! >= maxLon! || minLat! >= maxLat!) return 'INVALID_BBOX';
  if (maxLon! - minLon! > MAX_BBOX_DEGREES || maxLat! - minLat! > MAX_BBOX_DEGREES)
    return 'BBOX_TOO_LARGE';
  return null;
}
export function normalizePlaceSearch(request: TravelV1.SearchPlacesRequest) {
  const query = request.query?.normalize('NFKC').trim() ?? '';
  if (request.bbox && bboxProblem(request.bbox)) throw new Error('VALIDATION_FAILED');
  const bbox = request.bbox
    ? ([
        request.bbox.min_longitude,
        request.bbox.min_latitude,
        request.bbox.max_longitude,
        request.bbox.max_latitude,
      ] as [number, number, number, number])
    : undefined;
  const lat = request.coordinates?.latitude ?? (bbox ? (bbox[1] + bbox[3]) / 2 : undefined),
    lon = request.coordinates?.longitude ?? (bbox ? (bbox[0] + bbox[2]) / 2 : undefined);
  const radius = request.radius_m ?? 5000;
  const category = request.category ?? '';
  const groups = placeSearchGroups(category);
  const limit = request.limit ?? undefined;
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
    !groups ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) ||
    (request.geocode && query.length < 2) ||
    (request.geocode && bbox)
  )
    throw new Error('VALIDATION_FAILED');
  const geoapify = [
    ...new Set(groups.flatMap((g) => PLACE_CATEGORIES[g].split(',')).filter(Boolean)),
  ];
  return {
    query: bbox ? '' : query,
    latitude: Number(lat!.toFixed(4)),
    longitude: Number(lon!.toFixed(4)),
    radius,
    category,
    groups,
    codes: groups.flatMap((g) => POI_SEARCH_CATEGORIES[g]),
    geoapify: geoapify.join(','),
    limit,
    bbox,
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
  private readonly logger = new Logger(PlacesService.name);
  constructor(
    private readonly database: DatabaseProvider,
    private readonly config: ConfigService,
  ) {}
  async search(request: TravelV1.SearchPlacesRequest): Promise<TravelV1.SearchPlacesResponse> {
    const query = normalizePlaceSearch(request);
    const limit = query.limit ?? DEFAULT_LIMIT;
    // Wolfari catalogue first (not for address geocoding); Geoapify only when it falls short.
    const found: CatalogResult = query.geocode
      ? { snapshot: null, rows: [], truncated: false }
      : await this.catalog(query);
    const catalog = found.rows;
    const good = query.query
      ? catalog.filter((p) => p.golden_hit || p.exact || (p.sim ?? 0) >= GOOD_SIMILARITY).length
      : catalog.length;
    const wantsExternal =
      query.geocode ||
      (!query.bbox && query.geoapify !== '' && (query.query ? good < 3 : good === 0));
    const external = wantsExternal ? await this.external(query) : null;
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
          snapshot_id: '',
          data_release: '',
          bbox_truncated: false,
        },
      };
    const sign = (place: PlaceSnapshot) =>
      signPlaceSelection(
        {
          actor: request.actor_user_id!,
          trip: request.trip_id!,
          expires: Date.now() + 86400000,
          place,
        },
        secret,
      );
    const timestamp = (date: Date) => ({
      seconds: String(Math.floor(date.getTime() / 1000)),
      nanos: 0,
    });
    const curated: TravelV1.Place[] = catalog.slice(0, limit).map((poi) => {
      const place = catalogSnapshot(poi);
      const golden = poi.source_dataset !== 'overture';
      return {
        id: poi.wolfari_key,
        name: place.name,
        address: place.address,
        coordinates: { latitude: place.latitude, longitude: place.longitude },
        opening_hours: [],
        categories: place.categories,
        attribution: place.attribution,
        selection_token: sign(place),
        provider: 'WOLFARI',
        category: poi.category,
        category_label: poiCategoryLabel(poi.category),
        tier: poi.tier,
        coord_verified: poi.coord_verified,
        ...(poi.typical_duration_min ? { typical_duration_min: poi.typical_duration_min } : {}),
        activity_type: poi.activity_type ?? '',
        dress_code_hint: poi.dress_code_hint ?? '',
        source_dataset: golden ? 'golden' : 'overture',
        category_group: poiCategoryGroup(poi.category) ?? '',
        province_code: poi.province_code ?? '',
        province_name: vnProvinceName(poi.province_code),
        ...(!golden && poi.confidence !== null ? { confidence: poi.confidence } : {}),
        data_release: poi.source_release ?? '',
        fetched_at: timestamp(new Date(place.fetched_at)),
      };
    });
    const extra: TravelV1.Place[] = (external?.rows ?? [])
      .filter((place) => !duplicatesCatalog(place, catalog))
      .slice(0, Math.max(limit - curated.length, 0))
      .map((place) => ({
        id: place.provider_place_id,
        name: place.name,
        address: place.address,
        coordinates: { latitude: place.latitude, longitude: place.longitude },
        opening_hours: [],
        categories: place.categories,
        attribution,
        selection_token: sign(place),
        provider: 'GEOAPIFY',
        category: '',
        category_label: '',
        tier: 9,
        coord_verified: false,
        activity_type: '',
        dress_code_hint: '',
        source_dataset: 'geoapify',
        category_group: query.groups.length === 1 ? query.groups[0]! : '',
        province_code: '',
        province_name: '',
        data_release: '',
        fetched_at: timestamp(new Date(place.fetched_at)),
      }));
    const data = [...curated, ...extra];
    const warning = external?.warning;
    const fetched =
      extra.length || !curated.length
        ? (external?.fetched ?? new Date())
        : new Date(catalog[0]!.snapshot_at);
    return {
      data,
      meta: {
        status: data.length
          ? TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS
          : warning
            ? TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR
            : TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
        provider:
          curated.length && extra.length
            ? 'WOLFARI+GEOAPIFY'
            : curated.length
              ? 'WOLFARI'
              : 'GEOAPIFY',
        fetched_at: timestamp(fetched),
        stale: extra.length > 0 && external?.stale === true,
        is_mock: false,
        warnings: warning ? [warning] : [],
        snapshot_id: found.snapshot?.version ?? '',
        data_release: found.snapshot?.release ?? '',
        bbox_truncated: found.truncated,
      },
    };
  }
  /** Catalogue failure (e.g. migrations missing) degrades to the Geoapify-only behaviour. */
  private async catalog(query: ReturnType<typeof normalizePlaceSearch>): Promise<CatalogResult> {
    try {
      return await searchCatalog(this.database, query);
    } catch (error) {
      this.logger.warn(
        `POI_CATALOG_UNAVAILABLE ${error instanceof Error ? error.message.slice(0, 120) : ''}`,
      );
      return { snapshot: null, rows: [] as CatalogPoi[], truncated: false };
    }
  }
  private async external(query: ReturnType<typeof normalizePlaceSearch>) {
    const key = createHash('sha256').update(JSON.stringify(query)).digest('hex');
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.load(key, query);
      this.pending.set(key, promise);
    }
    try {
      return await promise;
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
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
        url.searchParams.set('categories', query.geoapify);
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
