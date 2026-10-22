import { describe, expect, it } from 'vitest';
import { RequestError } from './trip-http';
import { priceWatchRoute, priceWatchWrite } from './price-watch-proxy';

const trip = '11111111-1111-4111-8111-111111111111';
const watch = '22222222-2222-4222-8222-222222222222';

describe('price watch HTTP boundary', () => {
  it('maps only the seven declared routes', () => {
    expect(priceWatchRoute('POST', `/api/v1/trips/${trip}/price-watches`)).toEqual({
      kind: 'create',
      tripId: trip,
    });
    expect(priceWatchRoute('GET', `/api/v1/trips/${trip}/price-watches`)).toEqual({
      kind: 'list',
      tripId: trip,
    });
    expect(priceWatchRoute('PATCH', `/api/v1/price-watches/${watch}`)).toEqual({
      kind: 'update',
      watchId: watch,
    });
    expect(priceWatchRoute('POST', `/api/v1/price-watches/${watch}/pause`)).toEqual({
      kind: 'pause',
      watchId: watch,
    });
    expect(priceWatchRoute('GET', `/api/v1/price-watches/${watch}/observations`)).toEqual({
      kind: 'observations',
      watchId: watch,
    });
    expect(priceWatchRoute('DELETE', `/api/v1/price-watches/${watch}`)).toBeNull();
  });

  it('creates the complete protobuf write shape', () => {
    expect(
      priceWatchWrite(
        {
          provider: 'MOCK_FLIGHT',
          origin: 'DAD',
          destination: 'SGN',
          departure_date: '2099-11-01',
          return_date: null,
          journey_type: 'ONE_WAY',
          passengers: { adults: 1 },
          currency: 'VND',
          threshold_price: '2000000',
          departure_at: '2099-11-01T02:00:00Z',
        },
        false,
      ),
    ).toMatchObject({
      journey_type: 1,
      passengers: { adults: 1, children: 0, infants: 0 },
      threshold_price: '2000000',
      departure_at: { seconds: expect.any(String), nanos: 0 },
    });
  });

  it('encodes nullable patch fields as explicit oneof changes', () => {
    expect(
      priceWatchWrite({ expected_version: 4, return_date: null, cabin_class: 'business' }, true),
    ).toEqual({
      return_date: { clear: true },
      cabin_class: { value: 'business' },
      expected_version: 4,
    });
  });

  it('rejects unknown fields and empty patches', () => {
    expect(() => priceWatchWrite({ expected_version: 1, secret: 'x' }, true)).toThrowError(
      RequestError,
    );
    expect(() => priceWatchWrite({ expected_version: 1 }, true)).toThrowError(RequestError);
  });
});
