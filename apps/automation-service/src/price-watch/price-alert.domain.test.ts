import { describe, expect, it } from 'vitest';
import {
  PRICE_ALERT_COOLDOWN_MS,
  evaluatePriceAlert,
  priceAlertRetryDelay,
  type PriceAlertState,
} from './price-alert.domain';

const now = new Date('2026-10-22T12:00:00.000Z');
const state = (overrides: Partial<PriceAlertState> = {}): PriceAlertState => ({
  price: '1400000',
  thresholdPrice: '1500000',
  lastAlertPrice: null,
  lastAlertAt: null,
  alertArmed: true,
  evaluatedAt: now,
  ...overrides,
});

describe('Price Watch alert rule', () => {
  it('alerts the first time only below the threshold', () => {
    expect(evaluatePriceAlert(state())).toEqual({ rearm: false, reason: 'FIRST' });
    expect(evaluatePriceAlert(state({ price: '1500000' }))).toEqual({ rearm: true });
    expect(evaluatePriceAlert(state({ price: '1600000' }))).toEqual({ rearm: true });
  });

  it('allows a re-armed crossing after cooldown', () => {
    expect(
      evaluatePriceAlert(
        state({
          lastAlertPrice: '1400000',
          lastAlertAt: new Date(now.getTime() - PRICE_ALERT_COOLDOWN_MS),
          alertArmed: true,
          price: '1450000',
        }),
      ),
    ).toEqual({ rearm: false, reason: 'REARMED' });
  });

  it('accepts an exact five-percent drop without floating point', () => {
    const base = {
      lastAlertPrice: '2000001',
      lastAlertAt: new Date(now.getTime() - PRICE_ALERT_COOLDOWN_MS),
      alertArmed: false,
      thresholdPrice: '3000000',
    };
    expect(evaluatePriceAlert(state({ ...base, price: '1900000' }))).toEqual({
      rearm: false,
      reason: 'DROP_5_PERCENT',
    });
    expect(evaluatePriceAlert(state({ ...base, price: '1900001' }))).toEqual({ rearm: false });
  });

  it('keeps the trigger eligible while cooldown is active', () => {
    expect(
      evaluatePriceAlert(
        state({
          lastAlertPrice: '1500000',
          lastAlertAt: new Date(now.getTime() - PRICE_ALERT_COOLDOWN_MS + 1),
          alertArmed: true,
          price: '1000000',
        }),
      ),
    ).toEqual({ rearm: false });
    expect(
      evaluatePriceAlert(
        state({
          lastAlertPrice: '1500000',
          lastAlertAt: new Date(now.getTime() - PRICE_ALERT_COOLDOWN_MS),
          alertArmed: true,
          price: '1000000',
        }),
      ),
    ).toEqual({ rearm: false, reason: 'REARMED' });
  });

  it('supports signed-int64-sized values through bigint', () => {
    expect(
      evaluatePriceAlert(
        state({
          price: '8762203435012037016',
          thresholdPrice: '9000000000000000000',
          lastAlertPrice: '9223372036854775807',
          lastAlertAt: new Date(now.getTime() - PRICE_ALERT_COOLDOWN_MS),
          alertArmed: false,
        }),
      ),
    ).toEqual({ rearm: false, reason: 'DROP_5_PERCENT' });
  });

  it('rejects invalid internal money or timestamps', () => {
    expect(() => evaluatePriceAlert(state({ price: '0' }))).toThrow('price');
    expect(() => evaluatePriceAlert(state({ thresholdPrice: '1.5' }))).toThrow('thresholdPrice');
    expect(() => evaluatePriceAlert(state({ evaluatedAt: new Date('invalid') }))).toThrow(
      'evaluatedAt',
    );
    expect(() =>
      evaluatePriceAlert(state({ lastAlertAt: 'invalid', lastAlertPrice: '1' })),
    ).toThrow('lastAlertAt');
  });

  it('uses the shared finite retry schedule', () => {
    expect([1, 2, 3, 4, 5, 6].map(priceAlertRetryDelay)).toEqual([
      10_000,
      30_000,
      120_000,
      300_000,
      900_000,
      undefined,
    ]);
  });
});
