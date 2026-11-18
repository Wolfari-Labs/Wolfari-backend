import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import {
  catalogSnapshot,
  distanceMeters,
  duplicatesCatalog,
  foldName,
  searchCatalog,
  type CatalogPoi,
} from './poi-catalog';

const choHan: CatalogPoi = {
  wolfari_key: 'dn-cho-han',
  tier: 1,
  name_vi: 'Chợ Hàn',
  name_en: 'Han Market',
  aliases: ['Cho Han'],
  category: 'market',
  latitude: 16.068352,
  longitude: 108.224283,
  coord_verified: false,
  address: null,
  typical_duration_min: 60,
  activity_type: 'SHOPPING',
  dress_code_hint: null,
  attribution: '© OpenStreetMap contributors',
  snapshot_at: new Date('2026-11-18T11:26:28Z'),
  sim: 1,
  distance_m: 2500,
};
const geo = (name: string, latitude: number, longitude: number) => ({
  provider: 'GEOAPIFY' as const,
  provider_place_id: name,
  name,
  address: '',
  latitude,
  longitude,
  categories: [],
  fetched_at: '2026-11-18T00:00:00Z',
  attribution: 'Geoapify',
});

describe('POI catalogue helpers', () => {
  it('folds Vietnamese accents including đ', () => {
    expect(foldName('Đèo Hải Vân')).toBe('deo hai van');
    expect(foldName('  Chợ   Hàn! ')).toBe('cho han');
  });
  it('measures short distances in metres', () =>
    expect(Math.round(distanceMeters(16.0, 108.0, 16.001, 108.0))).toBe(111));
  it('treats a nearby same-name Geoapify hit as a duplicate', () => {
    expect(duplicatesCatalog(geo('Cho Han', 16.0687, 108.2245), [choHan])).toBe(true);
    expect(duplicatesCatalog(geo('Han Market', 16.0684, 108.2243), [choHan])).toBe(true);
    expect(duplicatesCatalog(geo('Chợ Hàn Đà Nẵng', 16.0684, 108.2243), [choHan])).toBe(true);
  });
  it('keeps far away or differently named Geoapify hits', () => {
    expect(duplicatesCatalog(geo('Chợ Hàn', 16.07, 108.2243), [choHan])).toBe(false);
    expect(duplicatesCatalog(geo('Cafe Mộc', 16.0684, 108.2243), [choHan])).toBe(false);
  });
  it('signs the curated wolfari_key with snapshot time as fetched_at', () =>
    expect(catalogSnapshot(choHan)).toEqual({
      provider: 'WOLFARI',
      provider_place_id: 'dn-cho-han',
      name: 'Chợ Hàn',
      address: '',
      latitude: 16.068352,
      longitude: 108.224283,
      categories: ['market'],
      fetched_at: '2026-11-18T11:26:28.000Z',
      attribution: '© OpenStreetMap contributors',
    }));
  it('maps public categories (accommodation included since POI-OVERTURE) and binds text as a parameter', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const db = { query } as unknown as DatabaseProvider;
    const base = { latitude: 16.0544, longitude: 108.2022, radius: 5000 };
    await searchCatalog(db, { ...base, query: '', category: 'unknown-group' });
    expect(query).not.toHaveBeenCalled();
    await searchCatalog(db, { ...base, query: "  cho   han%' --", category: 'restaurant' });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('unaccent($1::text)');
    expect(params).toEqual(["cho han%' --", ['restaurant', 'food_street'], 16.0544, 108.2022]);
    await searchCatalog(db, { ...base, query: '', category: 'cafe' });
    const nearby = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(nearby[1].slice(0, 4)).toEqual([['cafe'], 16.0544, 108.2022, 5000]);
    await searchCatalog(db, { ...base, query: '', category: 'accommodation' });
    const lodging = query.mock.calls[2] as unknown as [string, unknown[]];
    expect(lodging[1][0]).toEqual(['accommodation']);
  });
});
