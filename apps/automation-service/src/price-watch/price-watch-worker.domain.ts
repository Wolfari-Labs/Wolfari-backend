import type { NormalizedPriceQuery } from './price-watch.domain';

export const PRICE_WATCH_SLOT_MS = 6 * 60 * 60 * 1000;
export const PRICE_WATCH_RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 300_000, 900_000] as const;
export const PRICE_WATCH_MAX_PROVIDER_CALLS = PRICE_WATCH_RETRY_DELAYS_MS.length + 1;

const signedInt64Max = 9_223_372_036_854_775_807n;
const metadataKeys = new Set(['provider_fare_id', 'carrier_code', 'fare_class', 'baggage_summary']);

export type PriceProviderResult =
  | {
      kind: 'SUCCESS';
      price: string;
      currency: 'VND';
      provider: 'MOCK_FLIGHT';
      fare_metadata: Record<string, string | null>;
    }
  | { kind: 'NO_RESULT' };

export interface ClaimedPriceAttempt {
  id: string;
  query_group_id: string;
  scheduled_slot: string;
  attempt_count: number;
  canonical_key: string;
  query: NormalizedPriceQuery;
}

export interface ValidPriceObservation {
  price: string;
  currency: 'VND';
  provider: 'MOCK_FLIGHT';
  fare_metadata: Record<string, string | null>;
}

export class PriceProviderFailure extends Error {
  constructor(
    readonly errorCode: string,
    readonly transient: boolean,
  ) {
    super(errorCode);
  }
}

export function priceWatchSlot(at: Date): Date {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new Error('INVALID_SCHEDULER_TIME');
  return new Date(Math.floor(time / PRICE_WATCH_SLOT_MS) * PRICE_WATCH_SLOT_MS);
}

export function nextPriceWatchSlot(slot: Date): Date {
  return new Date(slot.getTime() + PRICE_WATCH_SLOT_MS);
}

export function retryDelay(attemptCount: number): number | undefined {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) return undefined;
  return PRICE_WATCH_RETRY_DELAYS_MS[attemptCount - 1];
}

export function validateProviderResult(value: PriceProviderResult): ValidPriceObservation | null {
  if (value.kind === 'NO_RESULT') return null;
  let price: bigint;
  try {
    if (!/^[1-9]\d*$/.test(value.price)) throw new Error('INVALID_PRICE');
    price = BigInt(value.price);
  } catch {
    throw new PriceProviderFailure('PROVIDER_RESPONSE_INVALID', false);
  }
  if (
    price > signedInt64Max ||
    value.currency !== 'VND' ||
    value.provider !== 'MOCK_FLIGHT' ||
    !value.fare_metadata ||
    Array.isArray(value.fare_metadata)
  )
    throw new PriceProviderFailure('PROVIDER_RESPONSE_INVALID', false);
  const metadata: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value.fare_metadata)) {
    if (
      !metadataKeys.has(key) ||
      (item !== null && (typeof item !== 'string' || item.length > 200 || item.includes('\0')))
    )
      throw new PriceProviderFailure('PROVIDER_RESPONSE_INVALID', false);
    metadata[key] = item;
  }
  return {
    price: price.toString(),
    currency: 'VND',
    provider: 'MOCK_FLIGHT',
    fare_metadata: metadata,
  };
}

export function safeProviderFailure(error: unknown): PriceProviderFailure {
  if (error instanceof PriceProviderFailure) return error;
  return new PriceProviderFailure('PROVIDER_UNAVAILABLE', true);
}
