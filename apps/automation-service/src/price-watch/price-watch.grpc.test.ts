import { describe, expect, it } from 'vitest';
import { safeFareMetadata } from './price-watch.grpc';

describe('Price Watch gRPC projection', () => {
  it('keeps only string/null public fare metadata fields', () => {
    expect(
      JSON.parse(
        safeFareMetadata({
          provider_fare_id: 'fare-1',
          carrier_code: 'VN',
          fare_class: null,
          baggage_summary: '20kg',
          private_url: 'https://provider.test/secret',
          raw_token: 'secret',
        }),
      ),
    ).toEqual({
      provider_fare_id: 'fare-1',
      carrier_code: 'VN',
      fare_class: null,
      baggage_summary: '20kg',
    });
  });

  it('drops malformed metadata instead of leaking or failing the read', () => {
    expect(safeFareMetadata(['secret'])).toBe('{}');
    expect(safeFareMetadata({ carrier_code: 123, fare_class: true })).toBe('{}');
  });
});
