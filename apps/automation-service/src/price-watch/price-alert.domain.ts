export const PRICE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const PRICE_ALERT_MAX_ATTEMPTS = 6;
export const PRICE_ALERT_RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 300_000, 900_000] as const;

export type PriceAlertReason = 'FIRST' | 'REARMED' | 'DROP_5_PERCENT';

export interface PriceAlertState {
  price: string;
  thresholdPrice: string;
  lastAlertPrice: string | null;
  lastAlertAt: Date | string | null;
  alertArmed: boolean;
  evaluatedAt: Date;
}

export interface PriceAlertDecision {
  rearm: boolean;
  reason?: PriceAlertReason;
}

function amount(value: string, name: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return BigInt(value);
}

function instant(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('lastAlertAt must be an instant');
  return result;
}

export function evaluatePriceAlert(state: PriceAlertState): PriceAlertDecision {
  const price = amount(state.price, 'price');
  const threshold = amount(state.thresholdPrice, 'thresholdPrice');
  if (!Number.isFinite(state.evaluatedAt.getTime())) throw new Error('evaluatedAt must be valid');
  if (price >= threshold) return { rearm: true };

  if (
    state.lastAlertAt !== null &&
    state.evaluatedAt.getTime() - instant(state.lastAlertAt) < PRICE_ALERT_COOLDOWN_MS
  )
    return { rearm: false };

  if (state.lastAlertPrice === null) return { rearm: false, reason: 'FIRST' };
  if (state.alertArmed) return { rearm: false, reason: 'REARMED' };
  const lastAlertPrice = amount(state.lastAlertPrice, 'lastAlertPrice');
  if (price * 100n <= lastAlertPrice * 95n) return { rearm: false, reason: 'DROP_5_PERCENT' };
  return { rearm: false };
}

export function priceAlertRetryDelay(attemptCount: number): number | undefined {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) return undefined;
  return PRICE_ALERT_RETRY_DELAYS_MS[attemptCount - 1];
}
