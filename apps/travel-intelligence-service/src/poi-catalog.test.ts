import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import {
  catalogSnapshot,
  compareHits,
  distanceMeters,
  duplicatesCatalog,
  foldName,
  searchCatalog,
  type CatalogPoi,
} from './poi-catalog';

const choHan: CatalogPoi = {
  poi_id: '00000000-0000-4000-8000-000000000001',
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
  province_code: '48',
  confidence: 1,
  source_dataset: null,
  source_release: null,
  fetched_at: null,
  coord_pileup: false,
  snapshot_at: new Date('2026-11-18T11:26:28Z'),
  sim: 1,
  distance_m: 2500,
  exact: true,
  golden_hit: true,
};
const overture = (key: string, over: Partial<CatalogPoi> = {}): CatalogPoi => ({
  ...choHan,
  wolfari_key: key,
  tier: 9,
  source_dataset: 'overture',
  confidence: 0.8,
  exact: false,
  golden_hit: false,
  sim: 0.5,
  ...over,
});
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
const SNAPSHOT = { id: 'snap-1', version: 'v', created_at: new Date(), release: null };
/** Fake DB: first query answers the active snapshot, later ones return `rows` per call. */
function fakeDb(...results: CatalogPoi[][]) {
  const query = vi.fn(async (sql: string) =>
    sql.includes('FROM poi_snapshots') ? { rows: [SNAPSHOT] } : { rows: results.shift() ?? [] },
  );
  return { query, db: { query } as unknown as DatabaseProvider };
}

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
  it('signs golden with snapshot time and Overture with its fetch time', () => {
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
    });
    const fetched = new Date('2026-11-18T14:30:00Z');
    expect(catalogSnapshot(overture('ov-1', { fetched_at: fetched })).fetched_at).toBe(
      '2026-11-18T14:30:00.000Z',
    );
  });
  it('ranks golden hits first, then exact name, tier, similarity, distance, confidence', () => {
    const exactOv = overture('ov-exact', { exact: true, sim: 1 });
    const strong = overture('ov-strong', { sim: 0.9 });
    const near = overture('ov-near', { sim: 0.5, distance_m: 10 });
    const sorted = [near, strong, exactOv, choHan].sort(compareHits).map((p) => p.wolfari_key);
    expect(sorted).toEqual(['dn-cho-han', 'ov-exact', 'ov-strong', 'ov-near']);
  });
  it('returns nothing without codes or without an active snapshot', async () => {
    const none = fakeDb();
    const base = { latitude: 16.0544, longitude: 108.2022, radius: 5000, query: '' };
    expect((await searchCatalog(none.db, { ...base, codes: [] })).rows).toEqual([]);
    expect(none.query).not.toHaveBeenCalled();
    const query = vi.fn(async () => ({ rows: [] }));
    const empty = await searchCatalog({ query } as unknown as DatabaseProvider, { ...base, codes: ['cafe'] });
    expect(empty).toEqual({ snapshot: null, rows: [], truncated: false });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('filters by the active snapshot id and binds text as a parameter', async () => {
    const { query, db } = fakeDb([choHan, overture('ov-a', { sim: 0.9 }), overture('ov-b', { sim: 0.8 })]);
    const base = { latitude: 16.0544, longitude: 108.2022, radius: 5000 };
    await searchCatalog(db, { ...base, query: "  cho   han%' --", codes: ['restaurant', 'food_street'] });
    const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain('unaccent($1::text)');
    expect(sql).toContain('p.snapshot_id = $5');
    expect(params.slice(0, 6)).toEqual(["cho han%' --", ['restaurant', 'food_street'], 16.0544, 108.2022, 'snap-1', 20]);
    expect(query).toHaveBeenCalledTimes(2); // 3 good local hits: no nationwide query
  });
  it('widens text search nationwide when the 50 km box has fewer than 3 good hits', async () => {
    const far = overture('ov-hanoi', { sim: 0.8, distance_m: 600000 });
    const { query, db } = fakeDb([], [far]);
    const result = await searchCatalog(db, {
      latitude: 16.0544,
      longitude: 108.2022,
      radius: 5000,
      query: 'ho guom',
      codes: ['nature_area'],
    });
    expect(query).toHaveBeenCalledTimes(4);
    const national = (query.mock.calls[2] as unknown as [string])[0];
    expect(national).not.toContain('BETWEEN $7');
    expect(national).toContain('LIKE');
    expect((query.mock.calls[3] as unknown as [string])[0]).toContain('<% p.search_text');
    expect(result.rows.map((r) => r.wolfari_key)).toEqual(['ov-hanoi']);
  });
  it('nearby search binds codes, centre, radius and snapshot id', async () => {
    const { query, db } = fakeDb([]);
    await searchCatalog(db, { latitude: 16.0544, longitude: 108.2022, radius: 5000, query: '', codes: ['cafe'] });
    const nearby = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(nearby[1].slice(0, 4)).toEqual([['cafe'], 16.0544, 108.2022, 5000]);
    expect(nearby[1][8]).toBe('snap-1');
  });
  it('bbox search hides coordinate pile-ups and reports truncation', async () => {
    const rows = [overture('ov-1'), overture('ov-2'), overture('ov-3')];
    const { query, db } = fakeDb(rows);
    const result = await searchCatalog(db, {
      latitude: 0,
      longitude: 0,
      radius: 5000,
      query: 'ignored',
      codes: ['cafe'],
      limit: 2,
      bbox: [108.1, 16.0, 108.3, 16.1],
    });
    const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain('NOT p.coord_pileup OR p.tier IN (1, 2, 3)');
    expect(params[8]).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
