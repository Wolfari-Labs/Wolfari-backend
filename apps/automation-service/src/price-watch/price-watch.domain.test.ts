import { describe, expect, it } from 'vitest';
import { AutomationV1 } from '@wolfari/contracts/grpc';
import { PriceWatchError } from './price-watch.errors';
import {
  expectedVersion,
  mergeWatchPatch,
  normalizeWatch,
  pageLimit,
  transition,
} from './price-watch.domain';

const context = {
  tripId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  membershipId: '33333333-3333-4333-8333-333333333333',
};
const now = new Date('2026-10-22T00:00:00.000Z');
const input = (): AutomationV1.PriceWatchWrite => ({
  provider: 'mock_flight',
  origin: 'dad',
  destination: 'sgn',
  departure_date: '2026-11-01',
  return_date: '2026-11-03',
  journey_type: AutomationV1.JourneyType.JOURNEY_TYPE_ROUND_TRIP,
  passengers: { adults: 2, children: 1, infants: 1 },
  cabin_class: 'economy',
  currency: 'vnd',
  threshold_price: '2500000',
  departure_at: { seconds: String(Date.parse('2026-11-01T02:00:00Z') / 1000), nanos: 0 },
});

function code(work: () => unknown, expected: string) {
  expect(work).toThrowError(PriceWatchError);
  try {
    work();
  } catch (error) {
    expect((error as PriceWatchError).code).toBe(expected);
  }
}

describe('price watch domain', () => {
  it('normalizes every price-affecting field into a stable shared key', () => {
    const first = normalizeWatch(input(), context, now);
    const second = normalizeWatch({ ...input(), provider: ' MOCK_FLIGHT ' }, context, now);
    expect(first.query).toEqual({
      provider: 'MOCK_FLIGHT',
      transport_type: 'FLIGHT',
      origin: 'DAD',
      destination: 'SGN',
      departure_date: '2026-11-01',
      return_date: '2026-11-03',
      journey_type: 'ROUND_TRIP',
      adults: 2,
      children: 1,
      infants: 1,
      passenger_count: 4,
      cabin_class: 'ECONOMY',
      currency: 'VND',
      departure_at: '2026-11-01T02:00:00.000Z',
    });
    expect(first.canonical_key).toBe(second.canonical_key);
    expect(first.expires_at).toBe('2026-11-01T02:00:00.000Z');
  });

  it('keeps threshold outside the shared query key but inside request identity', () => {
    const first = normalizeWatch(input(), context, now);
    const second = normalizeWatch({ ...input(), threshold_price: '2400000' }, context, now);
    expect(second.canonical_key).toBe(first.canonical_key);
    expect(second.request_hash).not.toBe(first.request_hash);
  });

  it('rejects invalid routes, trip shapes, passengers, amounts and expired departures', () => {
    code(
      () => normalizeWatch({ ...input(), destination: 'dad' }, context, now),
      'VALIDATION_FAILED',
    );
    code(
      () => normalizeWatch({ ...input(), return_date: undefined }, context, now),
      'VALIDATION_FAILED',
    );
    code(
      () => normalizeWatch({ ...input(), passengers: { adults: 1, infants: 2 } }, context, now),
      'VALIDATION_FAILED',
    );
    code(
      () => normalizeWatch({ ...input(), threshold_price: '0' }, context, now),
      'VALIDATION_FAILED',
    );
    code(
      () => normalizeWatch({ ...input(), threshold_price: '9223372036854775808' }, context, now),
      'VALIDATION_FAILED',
    );
    code(
      () => normalizeWatch({ ...input(), departure_at: { seconds: '1', nanos: 0 } }, context, now),
      'VALIDATION_FAILED',
    );
    code(
      () => normalizeWatch({ ...input(), departure_date: '2026-11-02' }, context, now),
      'VALIDATION_FAILED',
    );
  });

  it('merges a patch without changing omitted values', () => {
    const current = normalizeWatch(input(), context, now);
    const next = mergeWatchPatch(current, { threshold_price: '2000000' }, context, now);
    expect(next.query).toEqual(current.query);
    expect(next.threshold_price).toBe('2000000');
  });

  it('supports explicit clearing and rejects an empty patch', () => {
    const current = normalizeWatch(input(), context, now);
    const next = mergeWatchPatch(
      current,
      {
        journey_type: AutomationV1.JourneyType.JOURNEY_TYPE_ONE_WAY,
        return_date: { clear: true },
      },
      context,
      now,
    );
    expect(next.query.return_date).toBeNull();
    code(() => mergeWatchPatch(current, {}, context, now), 'VALIDATION_FAILED');
  });

  it('allows only declared state transitions', () => {
    expect(transition('ACTIVE', 'PAUSE')).toBe('PAUSED');
    expect(transition('PAUSED', 'RESUME')).toBe('ACTIVE');
    expect(transition('ACTIVE', 'STOP')).toBe('STOPPED');
    code(() => transition('STOPPED', 'RESUME'), 'STATE_CONFLICT');
  });

  it('bounds page limits and versions', () => {
    expect(pageLimit(0)).toBe(20);
    expect(pageLimit(100)).toBe(100);
    expect(expectedVersion(1)).toBe(1);
    code(() => pageLimit(101), 'VALIDATION_FAILED');
    code(() => expectedVersion(0), 'VALIDATION_FAILED');
  });
});
