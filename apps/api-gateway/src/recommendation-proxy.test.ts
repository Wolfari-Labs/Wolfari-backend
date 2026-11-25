import { describe, expect, it } from 'vitest';
import { weatherRequest } from './travel-proxy';

describe('Weather query', () => {
  it('accepts a coordinate and an ISO date', () => {
    const query = new URLSearchParams({
      latitude: '16.05',
      longitude: '108.2',
      date: '2026-12-01',
    });
    expect(weatherRequest(query)).toEqual({
      coordinate: { latitude: 16.05, longitude: 108.2 },
      date: '2026-12-01',
    });
  });
  it('rejects missing or malformed values', () => {
    for (const q of <Record<string, string>[]>[
      { latitude: '16', longitude: '108' },
      { latitude: 'x', longitude: '108', date: '2026-12-01' },
      { latitude: '', longitude: '108', date: '2026-12-01' },
      { latitude: '95', longitude: '108', date: '2026-12-01' },
      { latitude: '16', longitude: '108', date: '01/12/2026' },
    ])
      expect(() => weatherRequest(new URLSearchParams(q))).toThrow();
  });
});
