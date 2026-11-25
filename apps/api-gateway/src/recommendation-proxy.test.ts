import { describe, expect, it } from 'vitest';
import { recommendationRoute } from './recommendation-proxy';
import { weatherRequest } from './travel-proxy';

const trip = '10000000-0000-4000-8000-000000000001';
const rec = '30000000-0000-4000-8000-000000000003';

describe('Recommendation Gateway routes', () => {
  it('maps preview, apply and ignore and rejects other methods', () => {
    expect(recommendationRoute('POST', `/api/v1/trips/${trip}/recommendations`)).toEqual({
      action: 'PREVIEW',
      id: trip,
    });
    expect(recommendationRoute('POST', `/api/v1/recommendations/${rec}/apply`)).toEqual({
      action: 'APPLY',
      id: rec,
    });
    expect(recommendationRoute('POST', `/api/v1/recommendations/${rec}/ignore`)).toEqual({
      action: 'IGNORE',
      id: rec,
    });
    expect(recommendationRoute('GET', `/api/v1/trips/${trip}/recommendations`)).toBeNull();
    expect(recommendationRoute('DELETE', `/api/v1/recommendations/${rec}/apply`)).toBeNull();
    expect(recommendationRoute('POST', `/api/v1/recommendations/${rec}`)).toBeNull();
    expect(() => recommendationRoute('POST', '/api/v1/recommendations/nope/apply')).toThrow();
  });
});

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
