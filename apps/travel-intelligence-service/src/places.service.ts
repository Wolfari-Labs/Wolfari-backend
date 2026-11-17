import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status, type Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { timingSafeEqual } from 'node:crypto';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { TripAccessClient } from '@wolfari/contracts/trip-client';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizePlaceQuery(value: unknown) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value))
    throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Invalid query' });
  const query = value.trim().normalize('NFC');
  if (!query || [...query].length > 200)
    throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Invalid query' });
  return query;
}
export function decodeGeoapify(value: unknown): TravelV1.Place[] {
  const results = (value as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) throw Error('Invalid provider response');
  return results.slice(0, 8).map((value) => {
    const row = value as Record<string, unknown>;
    if (
      !row ||
      typeof row.place_id !== 'string' ||
      typeof row.formatted !== 'string' ||
      !Number.isFinite(row.lat) ||
      !Number.isFinite(row.lon) ||
      Math.abs(Number(row.lat)) > 90 ||
      Math.abs(Number(row.lon)) > 180
    )
      throw Error('Invalid provider place');
    return {
      id: row.place_id.slice(0, 500),
      name: (typeof row.name === 'string' && row.name ? row.name : row.formatted).slice(0, 500),
      address: row.formatted.slice(0, 1000),
      coordinates: { latitude: Number(row.lat), longitude: Number(row.lon) },
      opening_hours: [],
    };
  });
}

@Injectable()
export class PlacesService implements OnApplicationShutdown {
  private readonly access: TripAccessClient;
  private readonly cache = new Map<string, { data: TravelV1.Place[]; at: number }>();
  constructor(private readonly config: ConfigService) {
    const target = config.get<string>('TRIP_GRPC_TARGET') ?? '127.0.0.1:3202',
      secret = config.get<string>('TRAVEL_TRIP_SECRET') ?? '';
    if (!/^127\.0\.0\.1:\d+$/.test(target) || secret.length < 32)
      throw Error('Travel Trip configuration invalid');
    this.access = new TripAccessClient(target, 'Travel', secret);
  }
  async search(
    request: TravelV1.SearchPlacesRequest,
    metadata?: Metadata,
  ): Promise<TravelV1.SearchPlacesResponse> {
    const provided = Buffer.from(String(metadata?.get('x-service-secret')[0] ?? ''));
    const expected = Buffer.from(this.config.get<string>('GATEWAY_TRAVEL_SECRET') ?? '');
    const correlation = String(metadata?.get('x-correlation-id')[0] ?? '');
    if (
      metadata?.get('x-caller-service')[0] !== 'ApiGateway' ||
      expected.length < 32 ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected) ||
      !uuid.test(correlation)
    )
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Caller is not authorized',
      });
    if (!uuid.test(request.actor_user_id ?? '') || !uuid.test(request.trip_id ?? ''))
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'Invalid Trip context' });
    const query = normalizePlaceQuery(request.query);
    try {
      const context = await this.access.getAccessContext(
        { trip_id: request.trip_id!, user_id: request.actor_user_id!, action: 'TRIP_VIEW' },
        correlation,
        Date.now() + 1800,
      );
      if (!context.context?.can_read_trip || !context.context.membership)
        throw new RpcException({ code: status.NOT_FOUND, message: 'Trip unavailable' });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      const code = (error as { code?: number }).code;
      throw new RpcException({
        code:
          code === status.NOT_FOUND
            ? status.NOT_FOUND
            : code === status.PERMISSION_DENIED
              ? status.PERMISSION_DENIED
              : status.UNAVAILABLE,
        message: 'Trip access unavailable',
      });
    }
    return this.providerSearch(query);
  }
  async providerSearch(
    query: string,
    fetchRequest: typeof fetch = fetch,
  ): Promise<TravelV1.SearchPlacesResponse> {
    const now = Date.now(),
      cached = this.cache.get(query);
    const response = (
      data: TravelV1.Place[],
      at: number,
      warnings: string[] = [],
      stale = false,
    ): TravelV1.SearchPlacesResponse => ({
      data,
      meta: {
        status:
          warnings.includes('PROVIDER_NOT_CONFIGURED') ||
          (!data.length && warnings.includes('PROVIDER_UNAVAILABLE'))
            ? TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR
            : data.length
              ? TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS
              : TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT,
        provider: 'GEOAPIFY',
        fetched_at: { seconds: String(Math.floor(at / 1000)), nanos: 0 },
        stale,
        is_mock: false,
        warnings: [...warnings, 'OPENING_HOURS_NOT_AVAILABLE'],
        attribution: [
          { text: 'Geoapify', url: 'https://www.geoapify.com/' },
          { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
        ],
      },
    });
    if (cached && now - cached.at < 300000) return response(cached.data, cached.at);
    const key = this.config.get<string>('GEOAPIFY_API_KEY')?.trim();
    if (!key) return response([], now, ['PROVIDER_NOT_CONFIGURED']);
    try {
      const url = new URL('https://api.geoapify.com/v1/geocode/search');
      url.search = new URLSearchParams({
        text: query,
        format: 'json',
        limit: '8',
        lang: 'vi',
        apiKey: key,
      }).toString();
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 2500);
      try {
        const result = await fetchRequest(url, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!result.ok || Number(result.headers.get('content-length') ?? 0) > 1048576) {
          await result.body?.cancel();
          throw Error('Provider unavailable');
        }
        const reader = result.body?.getReader();
        if (!reader) throw Error('Empty provider response');
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 1048576) {
              await reader.cancel();
              throw Error('Provider response too large');
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const data = decodeGeoapify(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(query, { data, at: now });
        return response(data, now);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      if (cached && now - cached.at < 86400000)
        return response(cached.data, cached.at, ['STALE_CACHE', 'PROVIDER_UNAVAILABLE'], true);
      return response([], now, ['PROVIDER_UNAVAILABLE']);
    }
  }
  onApplicationShutdown() {
    this.access.close();
  }
}
