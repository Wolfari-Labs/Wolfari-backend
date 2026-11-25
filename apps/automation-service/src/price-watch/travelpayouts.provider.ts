import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  configuredFlightProvider,
  MockFlightPriceProvider,
  type PriceProviderRequest,
} from './price-watch-provider';
import {
  PriceProviderFailure,
  referencePriceFresh,
  type PriceProviderResult,
} from './price-watch-worker.domain';
import type { NormalizedPriceQuery } from './price-watch.domain';
export const FLIGHT_PRICE_PROVIDER = 'FLIGHT_PRICE_PROVIDER';
export interface FlightPriceProvider {
  fetch(request: PriceProviderRequest): Promise<PriceProviderResult>;
}

/**
 * Aviasales Data API v3 `get_latest_prices` for one departure day (period_type=day, documented at
 * support.travelpayouts.com article 203956163, checked 2026-11-23). It returns `found_at`, which the
 * alert freshness rule needs. `show_to_affiliates=false` asks for every cached price, not only those
 * found through partner links, so Vietnamese domestic routes are not needlessly empty.
 */
export function travelpayoutsUrl(
  query: Pick<NormalizedPriceQuery, 'origin' | 'destination' | 'departure_date'>,
): URL {
  const url = new URL('https://api.travelpayouts.com/aviasales/v3/get_latest_prices');
  url.search = new URLSearchParams({
    origin: query.origin,
    destination: query.destination,
    period_type: 'day',
    beginning_of_period: query.departure_date,
    one_way: 'true',
    trip_class: '0',
    currency: 'vnd',
    sorting: 'price',
    show_to_affiliates: 'false',
    limit: '20',
    page: '1',
  }).toString();
  return url;
}

export function parseTravelpayouts(
  payload: unknown,
  query: NormalizedPriceQuery,
  verifiedVnd: boolean,
  now = Date.now(),
): PriceProviderResult {
  const fail = () => {
    throw new PriceProviderFailure('PROVIDER_RESPONSE_INVALID', false);
  };
  if (!payload || typeof payload !== 'object' || !verifiedVnd) return fail();
  const root = payload as Record<string, unknown>;
  if (
    root.success !== true ||
    !Array.isArray(root.data) ||
    (root.currency !== undefined && String(root.currency).toUpperCase() !== 'VND')
  )
    return fail();
  const rows: { price: number; row: Record<string, unknown> }[] = [];
  for (const item of root.data) {
    if (!item || typeof item !== 'object') return fail();
    const row = item as Record<string, unknown>;
    if (
      row.origin !== query.origin ||
      row.destination !== query.destination ||
      row.depart_date !== query.departure_date ||
      (row.return_date !== '' && row.return_date !== null && row.return_date !== undefined) ||
      // The documented response omits trip_class on some rows; the request already asks for 0.
      (row.trip_class !== undefined && row.trip_class !== 0) ||
      row.actual === false
    )
      continue;
    if (row.currency !== undefined && String(row.currency).toUpperCase() !== 'VND') return fail();
    if (typeof row.value !== 'number' || !Number.isFinite(row.value)) return fail();
    // Prices are converted from the cache currency; VND has no minor unit, so keep whole dong.
    const price = Math.round(row.value);
    if (!Number.isSafeInteger(price) || price <= 0) return fail();
    rows.push({ price, row });
  }
  const best = rows.sort((a, b) => a.price - b.price)[0];
  if (!best) return { kind: 'NO_RESULT' };
  const found =
    typeof best.row.found_at === 'string' && Number.isFinite(Date.parse(best.row.found_at))
      ? new Date(best.row.found_at).toISOString()
      : null;
  const expires =
    best.row.expires_at == null
      ? null
      : typeof best.row.expires_at === 'string' && Number.isFinite(Date.parse(best.row.expires_at))
        ? new Date(best.row.expires_at).toISOString()
        : 'UNKNOWN';
  const metadata: Record<string, string | null> = {
    data_kind: 'CACHED_REFERENCE',
    provider_found_at: found,
    provider_expires_at: expires,
    fare_class: 'ECONOMY',
    provider_fare_id: createHash('sha256').update(JSON.stringify(best.row)).digest('hex'),
  };
  metadata.source_freshness = referencePriceFresh('TRAVELPAYOUTS_CACHE', metadata, now)
    ? 'FRESH_REFERENCE'
    : found
      ? 'STALE'
      : 'UNKNOWN';
  return {
    kind: 'SUCCESS',
    fetched_at: new Date(now).toISOString(),
    provider: 'TRAVELPAYOUTS_CACHE',
    price: String(best.price),
    currency: 'VND',
    fare_metadata: metadata,
  };
}

@Injectable()
export class ConfiguredFlightPriceProvider implements FlightPriceProvider {
  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseProvider,
    private readonly mock: MockFlightPriceProvider,
  ) {}
  async fetch(request: PriceProviderRequest): Promise<PriceProviderResult> {
    const provider = configuredFlightProvider(this.config);
    if (request.query.provider !== provider)
      throw new PriceProviderFailure('PROVIDER_NOT_SUPPORTED', false);
    if (provider === 'MOCK_FLIGHT') {
      if (this.config.get<string>('NODE_ENV') === 'production')
        throw new PriceProviderFailure('PROVIDER_NOT_SUPPORTED', false);
      return this.mock.fetch(request);
    }
    const token = this.config.get<string>('TRAVELPAYOUTS_TOKEN')?.trim();
    if (
      provider !== 'TRAVELPAYOUTS_CACHE' ||
      !token ||
      this.config.get<string>('TRAVELPAYOUTS_VND_VERIFIED') !== 'true'
    )
      throw new PriceProviderFailure('PROVIDER_NOT_CONFIGURED', false);
    const acquire = () =>
      this.database
        .query(`INSERT INTO price_provider_limits(provider,next_call_at) VALUES('TRAVELPAYOUTS_CACHE',clock_timestamp()+interval '1 second')
      ON CONFLICT(provider) DO UPDATE SET next_call_at=EXCLUDED.next_call_at WHERE price_provider_limits.next_call_at<=clock_timestamp() RETURNING provider`);
    let permit = await acquire();
    if (!permit.rowCount) {
      const state = await this.database.query<{ wait_ms: number }>(
        "SELECT GREATEST(0,EXTRACT(EPOCH FROM next_call_at-clock_timestamp())*1000)::int AS wait_ms FROM price_provider_limits WHERE provider='TRAVELPAYOUTS_CACHE'",
      );
      const wait = state.rows[0]?.wait_ms;
      if (wait !== undefined && wait <= 1100) {
        try {
          await delay(wait + 10, undefined, { signal: request.signal });
        } catch {
          throw new PriceProviderFailure('PROVIDER_TIMEOUT', true);
        }
        permit = await acquire();
      }
    }
    if (!permit.rowCount) throw new PriceProviderFailure('PROVIDER_RATE_LIMITED', true);
    const url = travelpayoutsUrl(request.query);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'X-Access-Token': token },
        signal: request.signal,
        redirect: 'error',
      });
    } catch {
      throw new PriceProviderFailure(
        request.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        true,
      );
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = Number(retry ?? response.headers.get('x-rate-limit-reset'));
      const until =
        retry && !/^\d+$/.test(retry)
          ? Date.parse(retry)
          : Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
      await this.database.query(
        "UPDATE price_provider_limits SET next_call_at=GREATEST(next_call_at,$1) WHERE provider='TRAVELPAYOUTS_CACHE'",
        [new Date(Number.isFinite(until) ? until : Date.now() + 60000)],
      );
      throw new PriceProviderFailure('PROVIDER_RATE_LIMITED', true);
    }
    if ([401, 403].includes(response.status))
      throw new PriceProviderFailure('PROVIDER_AUTH_FAILED', false);
    if (!response.ok)
      throw new PriceProviderFailure('PROVIDER_UNAVAILABLE', response.status >= 500);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PriceProviderFailure('PROVIDER_RESPONSE_INVALID', false);
    }
    return parseTravelpayouts(payload, request.query, true);
  }
}
