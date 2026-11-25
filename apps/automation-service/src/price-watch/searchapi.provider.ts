import {
  PriceProviderFailure,
  referencePriceFresh,
  type PriceProviderResult,
} from './price-watch-worker.domain';
import type { NormalizedPriceQuery } from './price-watch.domain';

type FlightRoute = Pick<NormalizedPriceQuery, 'origin' | 'destination' | 'departure_date'>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function fetchSearchApiFare(
  query: FlightRoute,
  key: string,
  signal: AbortSignal,
): Promise<PriceProviderResult> {
  const url = new URL('https://www.searchapi.io/api/v1/search');
  url.search = new URLSearchParams({
    engine: 'google_flights',
    flight_type: 'one_way',
    departure_id: query.origin,
    arrival_id: query.destination,
    outbound_date: query.departure_date,
    travel_class: 'economy',
    adults: '1',
    currency: 'VND',
    gl: 'vn',
    hl: 'en',
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal,
      redirect: 'error',
    });
  } catch {
    throw new PriceProviderFailure(
      signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      true,
    );
  }
  if ([401, 403].includes(response.status))
    throw new PriceProviderFailure('PROVIDER_AUTH_FAILED', false);
  if ([402, 429].includes(response.status))
    throw new PriceProviderFailure('PROVIDER_RATE_LIMITED', false);
  if (!response.ok) throw new PriceProviderFailure('PROVIDER_UNAVAILABLE', response.status >= 500);
  const payload: unknown = await response.json().catch(() => {
    throw new PriceProviderFailure(
      signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_RESPONSE_INVALID',
      signal.aborted,
    );
  });
  return parseSearchApiFare(payload, query);
}

export function parseSearchApiFare(
  payload: unknown,
  query: FlightRoute,
  now = Date.now(),
): PriceProviderResult {
  const invalid = () => new PriceProviderFailure('PROVIDER_RESPONSE_INVALID', false);
  if (
    !record(payload) ||
    payload.error ||
    !record(payload.search_metadata) ||
    payload.search_metadata.status !== 'Success' ||
    !record(payload.search_parameters)
  )
    throw invalid();
  const params = payload.search_parameters;
  if (
    params.currency !== 'VND' ||
    params.departure_id !== query.origin ||
    params.arrival_id !== query.destination ||
    params.outbound_date !== query.departure_date ||
    params.flight_type !== 'one_way'
  )
    throw invalid();
  let lowest: number | undefined;
  for (const group of [payload.best_flights, payload.other_flights]) {
    if (group === undefined) continue;
    if (!Array.isArray(group)) throw invalid();
    for (const offer of group) {
      if (!record(offer) || !Array.isArray(offer.flights) || !offer.flights.length) throw invalid();
      const departure = offer.flights[0]?.departure_airport;
      const arrival = offer.flights.at(-1)?.arrival_airport;
      if (
        departure?.id !== query.origin ||
        arrival?.id !== query.destination ||
        departure?.date !== query.departure_date
      )
        continue;
      if (offer.price == null) continue;
      if (typeof offer.price !== 'number' || !Number.isSafeInteger(offer.price) || offer.price <= 0)
        throw invalid();
      lowest = Math.min(lowest ?? offer.price, offer.price);
    }
  }
  if (lowest === undefined) return { kind: 'NO_RESULT' };
  const timestamp = payload.search_metadata.created_at;
  const found =
    typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : null;
  const metadata = { data_kind: 'FLIGHT_SEARCH', provider_found_at: found, fare_class: 'ECONOMY' };
  return {
    kind: 'SUCCESS',
    fetched_at: new Date(now).toISOString(),
    price: String(lowest),
    currency: 'VND',
    provider: 'SEARCHAPI_GOOGLE_FLIGHTS',
    fare_metadata: {
      ...metadata,
      source_freshness: !found
        ? 'UNKNOWN'
        : referencePriceFresh('SEARCHAPI_GOOGLE_FLIGHTS', metadata, now)
          ? 'FRESH_REFERENCE'
          : 'STALE',
    },
  };
}
