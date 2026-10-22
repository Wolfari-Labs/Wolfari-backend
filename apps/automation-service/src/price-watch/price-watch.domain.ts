import { createHash } from 'node:crypto';
import { AutomationV1 } from '@wolfari/contracts/grpc';
import { priceWatchFail } from './price-watch.errors';

export type WatchStatus = 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'STOPPED';
export type Journey = 'ONE_WAY' | 'ROUND_TRIP';

export interface NormalizedPriceQuery {
  provider: 'MOCK_FLIGHT';
  transport_type: 'FLIGHT';
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string | null;
  journey_type: Journey;
  adults: number;
  children: number;
  infants: number;
  passenger_count: number;
  cabin_class: 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
  currency: 'VND';
  departure_at: string;
}

export interface NormalizedWatchWrite {
  query: NormalizedPriceQuery;
  threshold_price: string;
  canonical_key: string;
  request_hash: string;
  expires_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IATA = /^[A-Z]{3}$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

export function watchUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return priceWatchFail('VALIDATION_FAILED');
  return value.toLowerCase();
}

export function expectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    return priceWatchFail('VALIDATION_FAILED');
  return Number(value);
}

export function pageLimit(value: unknown): number {
  const result = value === undefined || value === 0 ? 20 : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 100)
    return priceWatchFail('VALIDATION_FAILED');
  return result;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return priceWatchFail('VALIDATION_FAILED');
  const normalized = value.normalize('NFKC').trim().toUpperCase();
  if (!normalized || normalized.length > max) return priceWatchFail('VALIDATION_FAILED');
  return normalized;
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string') return priceWatchFail('VALIDATION_FAILED');
  const match = DATE.exec(value);
  if (!match) return priceWatchFail('VALIDATION_FAILED');
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.toISOString().slice(0, 10) !== value) return priceWatchFail('VALIDATION_FAILED');
  return value;
}

function timestamp(value: { seconds?: string; nanos?: number } | undefined): string {
  if (!value || typeof value.seconds !== 'string' || !/^-?\d+$/.test(value.seconds))
    return priceWatchFail('VALIDATION_FAILED');
  const nanos = value.nanos;
  if (!Number.isInteger(nanos) || Number(nanos) < 0 || Number(nanos) > 999_999_999)
    return priceWatchFail('VALIDATION_FAILED');
  const seconds = Number(value.seconds);
  if (!Number.isSafeInteger(seconds)) return priceWatchFail('VALIDATION_FAILED');
  const date = new Date(seconds * 1000 + Math.floor(Number(nanos) / 1_000_000));
  if (Number.isNaN(date.getTime())) return priceWatchFail('VALIDATION_FAILED');
  return date.toISOString();
}

function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    return priceWatchFail('VALIDATION_FAILED');
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) return priceWatchFail('VALIDATION_FAILED');
  return parsed.toString();
}

function passengers(value: AutomationV1.PassengerMix | undefined) {
  if (!value) return priceWatchFail('VALIDATION_FAILED');
  const adults = value.adults;
  const children = value.children ?? 0;
  const infants = value.infants ?? 0;
  if (
    !Number.isInteger(adults) ||
    !Number.isInteger(children) ||
    !Number.isInteger(infants) ||
    Number(adults) < 1 ||
    Number(adults) > 9 ||
    Number(children) < 0 ||
    Number(children) > 9 ||
    Number(infants) < 0 ||
    Number(infants) > Number(adults) ||
    Number(adults) + Number(children) + Number(infants) > 9
  )
    return priceWatchFail('VALIDATION_FAILED');
  return {
    adults: Number(adults),
    children: Number(children),
    infants: Number(infants),
    passenger_count: Number(adults) + Number(children) + Number(infants),
  };
}

function journey(value: AutomationV1.JourneyType | undefined): Journey {
  if (value === AutomationV1.JourneyType.JOURNEY_TYPE_ONE_WAY) return 'ONE_WAY';
  if (value === AutomationV1.JourneyType.JOURNEY_TYPE_ROUND_TRIP) return 'ROUND_TRIP';
  return priceWatchFail('VALIDATION_FAILED');
}

function change(value: AutomationV1.StringChange | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const hasValue = value.value !== undefined;
  const hasClear = value.clear !== undefined;
  if (hasValue === hasClear || (hasClear && value.clear !== true))
    return priceWatchFail('VALIDATION_FAILED');
  return hasValue ? value.value! : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeWatch(
  value: AutomationV1.PriceWatchWrite,
  context: { tripId: string; userId: string; membershipId: string },
  now = new Date(),
): NormalizedWatchWrite {
  const provider = text(value.provider, 50);
  if (provider !== 'MOCK_FLIGHT') return priceWatchFail('VALIDATION_FAILED');
  const origin = text(value.origin, 3);
  const destination = text(value.destination, 3);
  if (!IATA.test(origin) || !IATA.test(destination) || origin === destination)
    return priceWatchFail('VALIDATION_FAILED');
  const departureDate = calendarDate(value.departure_date);
  const tripJourney = journey(value.journey_type);
  const returnDate = value.return_date === undefined ? null : calendarDate(value.return_date);
  if (
    (tripJourney === 'ONE_WAY' && returnDate !== null) ||
    (tripJourney === 'ROUND_TRIP' && !returnDate)
  )
    return priceWatchFail('VALIDATION_FAILED');
  if (returnDate && returnDate < departureDate) return priceWatchFail('VALIDATION_FAILED');
  const cabin = text(value.cabin_class ?? 'ECONOMY', 30);
  if (!['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(cabin))
    return priceWatchFail('VALIDATION_FAILED');
  const currency = text(value.currency, 3);
  if (currency !== 'VND') return priceWatchFail('VALIDATION_FAILED');
  const departureAt = timestamp(value.departure_at);
  if (new Date(departureAt).getTime() <= now.getTime()) return priceWatchFail('VALIDATION_FAILED');
  if (departureAt.slice(0, 10) !== departureDate) return priceWatchFail('VALIDATION_FAILED');
  const mix = passengers(value.passengers);
  const query: NormalizedPriceQuery = {
    provider,
    transport_type: 'FLIGHT',
    origin,
    destination,
    departure_date: departureDate,
    return_date: returnDate,
    journey_type: tripJourney,
    ...mix,
    cabin_class: cabin as NormalizedPriceQuery['cabin_class'],
    currency,
    departure_at: departureAt,
  };
  const threshold = amount(value.threshold_price);
  const canonicalKey = digest(query);
  return {
    query,
    threshold_price: threshold,
    canonical_key: canonicalKey,
    request_hash: digest({ ...context, query, threshold_price: threshold }),
    expires_at: departureAt,
  };
}

export function mergeWatchPatch(
  current: NormalizedWatchWrite,
  patch: AutomationV1.PriceWatchPatch,
  context: { tripId: string; userId: string; membershipId: string },
  now = new Date(),
): NormalizedWatchWrite {
  if (!patch || Object.keys(patch).length === 0) return priceWatchFail('VALIDATION_FAILED');
  const returnDate = change(patch.return_date);
  const cabin = change(patch.cabin_class);
  const next: AutomationV1.PriceWatchWrite = {
    provider: patch.provider ?? current.query.provider,
    origin: patch.origin ?? current.query.origin,
    destination: patch.destination ?? current.query.destination,
    departure_date: patch.departure_date ?? current.query.departure_date,
    return_date:
      returnDate === undefined
        ? (current.query.return_date ?? undefined)
        : (returnDate ?? undefined),
    journey_type:
      patch.journey_type ??
      (current.query.journey_type === 'ONE_WAY'
        ? AutomationV1.JourneyType.JOURNEY_TYPE_ONE_WAY
        : AutomationV1.JourneyType.JOURNEY_TYPE_ROUND_TRIP),
    passengers: patch.passengers ?? {
      adults: current.query.adults,
      children: current.query.children,
      infants: current.query.infants,
    },
    cabin_class: cabin === undefined ? current.query.cabin_class : (cabin ?? undefined),
    currency: patch.currency ?? current.query.currency,
    threshold_price: patch.threshold_price ?? current.threshold_price,
    departure_at: patch.departure_at ?? {
      seconds: String(Math.floor(new Date(current.query.departure_at).getTime() / 1000)),
      nanos: (new Date(current.query.departure_at).getTime() % 1000) * 1_000_000,
    },
  };
  return normalizeWatch(next, context, now);
}

export function transition(status: WatchStatus, command: 'PAUSE' | 'RESUME' | 'STOP'): WatchStatus {
  if (command === 'PAUSE' && status === 'ACTIVE') return 'PAUSED';
  if (command === 'RESUME' && status === 'PAUSED') return 'ACTIVE';
  if (command === 'STOP' && (status === 'ACTIVE' || status === 'PAUSED')) return 'STOPPED';
  return priceWatchFail('STATE_CONFLICT');
}
