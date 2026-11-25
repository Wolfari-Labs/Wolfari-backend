import type { PlaceSnapshot } from '@wolfari/common';
import type { DatabaseProvider } from '@wolfari/database';

/** A POI row from the active snapshot (travel_db V003–V005). */
export type CatalogPoi = {
  /** pois.id of the active snapshot (used to attach POI-IMAGES photos). */
  poi_id: string;
  wolfari_key: string;
  tier: number;
  name_vi: string;
  name_en: string | null;
  aliases: string[];
  category: string;
  latitude: number;
  longitude: number;
  coord_verified: boolean;
  address: string | null;
  typical_duration_min: number | null;
  activity_type: string | null;
  dress_code_hint: string | null;
  attribution: string | null;
  province_code: string | null;
  confidence: number | null;
  source_dataset: string | null;
  source_release: string | null;
  fetched_at: Date | null;
  coord_pileup: boolean;
  snapshot_at: Date;
  sim: number | null;
  distance_m: number;
  /** Query equals the name, English name or an alias once accents are removed. */
  exact: boolean;
  /** Golden POI whose text contains the query or matches it exactly: always ranked first. */
  golden_hit: boolean;
};
type Queryable = Pick<DatabaseProvider, 'query'> & Partial<Pick<DatabaseProvider, 'withTransaction'>>;

export type ActiveSnapshot = { id: string; version: string; created_at: Date; release: string | null };

export const CATALOG_ATTRIBUTION = '© OpenStreetMap contributors';
/** A catalogue hit counts as "good enough" to skip Geoapify at this similarity. */
export const GOOD_SIMILARITY = 0.3;
/** Text search looks this far around the trip/map centre before going nationwide. */
export const LOCAL_TEXT_RADIUS_M = 50_000;
export const DEFAULT_LIMIT = 20;
export const DEFAULT_BBOX_LIMIT = 150;
export const MAX_LIMIT = 300;
/** A map frame may span at most this many degrees in each direction. */
export const MAX_BBOX_DEGREES = 2;

/** The active snapshot, read on every request (activation needs no restart). */
export async function activeSnapshot(db: Queryable): Promise<ActiveSnapshot | null> {
  const { rows } = await db.query<ActiveSnapshot>(
    `SELECT id, version, created_at, manifest->>'release' AS release
     FROM poi_snapshots WHERE is_active LIMIT 1`,
  );
  return rows[0] ?? null;
}

const DISTANCE_SQL = `(2 * 6371000 * asin(sqrt(
  power(sin(radians(p.latitude::float8 - $LAT) / 2), 2) +
  cos(radians($LAT)) * cos(radians(p.latitude::float8)) *
  power(sin(radians(p.longitude::float8 - $LON) / 2), 2))))`;
const COLUMNS = `p.id AS poi_id, p.wolfari_key, p.tier, p.name_vi, p.name_en, p.aliases, p.category,
  p.latitude::float8 AS latitude, p.longitude::float8 AS longitude, p.coord_verified, p.address,
  p.typical_duration_min, p.activity_type, p.dress_code_hint, p.attribution, p.province_code,
  p.confidence::float8 AS confidence, p.source_dataset, p.source_release, p.fetched_at, p.coord_pileup`;

/** Fuzzy fallback threshold: 0.6 (default) pulls ~100k GIN candidates for short common words. */
export const FUZZY_WORD_SIMILARITY = 0.7;
/**
 * Text search inside one snapshot ($5), optionally inside a lat/lon box ($7–$10).
 * contains: accent-folded substring (LIKE), served by GIN (snapshot_id, search_text).
 * fuzzy: word similarity `<%` (pg_trgm.word_similarity_threshold), also GIN; only as a fallback.
 */
function textSql(boxed: boolean, fuzzy = false) {
  return `WITH q AS (
  SELECT t, replace(replace(replace(t, '\\', '\\\\'), '%', '\\%'), '_', '\\_') AS pattern
  FROM (SELECT lower(unaccent($1::text)) AS t) raw
)
SELECT *, (tier IN (1, 2, 3) AND (exact OR contains)) AS golden_hit FROM (
  SELECT ${COLUMNS},
    GREATEST(similarity(p.search_text, q.t), word_similarity(q.t, p.search_text))::float8 AS sim,
    ${DISTANCE_SQL.replaceAll('$LAT', '$3').replaceAll('$LON', '$4')} AS distance_m,
    p.search_text LIKE '%' || q.pattern || '%' AS contains,
    EXISTS (SELECT 1 FROM unnest(p.aliases || ARRAY[p.name_vi::text, coalesce(p.name_en, '')::text]) n
            WHERE lower(unaccent(n)) = q.t) AS exact
  FROM pois p CROSS JOIN q
  WHERE p.snapshot_id = $5 AND p.category = ANY($2::text[])
    ${boxed ? 'AND p.latitude BETWEEN $7 AND $8 AND p.longitude BETWEEN $9 AND $10' : ''}
    AND ${fuzzy ? 'q.t <% p.search_text' : "p.search_text LIKE '%' || q.pattern || '%'"}
) hit
ORDER BY golden_hit DESC, exact DESC, (tier IN (1, 2, 3)) DESC, sim DESC, distance_m, confidence DESC, wolfari_key
LIMIT $6`;
}

/** No text: catalogue points within radius_m of the centre, by tier then distance. */
const NEARBY_SQL = `SELECT * FROM (
  SELECT ${COLUMNS}, NULL::float8 AS sim, false AS exact, false AS golden_hit,
    ${DISTANCE_SQL.replaceAll('$LAT', '$2').replaceAll('$LON', '$3')} AS distance_m
  FROM pois p
  WHERE p.snapshot_id = $9 AND p.category = ANY($1::text[])
    AND p.latitude BETWEEN $5 AND $6 AND p.longitude BETWEEN $7 AND $8
) near
WHERE distance_m <= $4
ORDER BY tier, distance_m, wolfari_key
LIMIT $10`;

/** Map frame: lowest tier first, then confidence; coordinate pile-ups stay off the map. */
const BBOX_SQL = `SELECT ${COLUMNS}, NULL::float8 AS sim, false AS exact, false AS golden_hit,
    ${DISTANCE_SQL.replaceAll('$LAT', '$2').replaceAll('$LON', '$3')} AS distance_m
  FROM pois p
  WHERE p.snapshot_id = $1 AND p.category = ANY($4::text[])
    AND p.latitude BETWEEN $5 AND $6 AND p.longitude BETWEEN $7 AND $8
    AND (NOT p.coord_pileup OR p.tier IN (1, 2, 3))
  ORDER BY p.tier, p.confidence DESC, p.wolfari_key
  LIMIT $9`;

export interface CatalogQuery {
  query: string;
  latitude: number;
  longitude: number;
  radius: number;
  /** Taxonomy codes to search (already resolved from the public category groups). */
  codes: readonly string[];
  limit?: number;
  /** Map frame [minLon, minLat, maxLon, maxLat]; when set, radius and query are ignored. */
  bbox?: readonly [number, number, number, number];
}
export interface CatalogResult {
  snapshot: ActiveSnapshot | null;
  rows: CatalogPoi[];
  truncated: boolean;
}

/** Search order: golden hit, exact name, golden tier, similarity, distance, confidence, key. */
export function compareHits(a: CatalogPoi, b: CatalogPoi): number {
  const golden = (p: CatalogPoi) => (p.tier <= 3 ? 1 : 0);
  return (
    Number(b.golden_hit) - Number(a.golden_hit) ||
    Number(b.exact) - Number(a.exact) ||
    golden(b) - golden(a) ||
    (b.sim ?? 0) - (a.sim ?? 0) ||
    a.distance_m - b.distance_m ||
    (b.confidence ?? 1) - (a.confidence ?? 1) ||
    a.wolfari_key.localeCompare(b.wolfari_key)
  );
}
const isGood = (p: CatalogPoi) => p.golden_hit || p.exact || (p.sim ?? 0) >= GOOD_SIMILARITY;
/** Degrees of latitude/longitude spanned by `meters` around a latitude. */
function box(latitude: number, meters: number) {
  const dLat = meters / 111320;
  const dLon = meters / (111320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  return { dLat, dLon };
}

export async function searchCatalog(db: Queryable, input: CatalogQuery): Promise<CatalogResult> {
  const empty = { snapshot: null, rows: [], truncated: false };
  if (!input.codes.length) return empty;
  const snapshot = await activeSnapshot(db);
  if (!snapshot) return empty;
  const codes = [...input.codes];
  const at = (rows: Omit<CatalogPoi, 'snapshot_at'>[]) =>
    rows.map((row) => ({ ...row, snapshot_at: snapshot.created_at }) as CatalogPoi);

  if (input.bbox) {
    const limit = Math.min(input.limit ?? DEFAULT_BBOX_LIMIT, MAX_LIMIT);
    const [minLon, minLat, maxLon, maxLat] = input.bbox;
    const rows = at(
      (
        await db.query<CatalogPoi>(BBOX_SQL, [
          snapshot.id,
          (minLat + maxLat) / 2,
          (minLon + maxLon) / 2,
          codes,
          minLat,
          maxLat,
          minLon,
          maxLon,
          limit + 1,
        ])
      ).rows,
    );
    return { snapshot, rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const text = input.query.replace(/\s+/g, ' ').trim();
  if (text) {
    // Spatial filter first (50 km around the centre); nationwide only when that finds < 3 good hits.
    const { dLat, dLon } = box(input.latitude, LOCAL_TEXT_RADIUS_M);
    const base = [text, codes, input.latitude, input.longitude, snapshot.id, limit];
    const local = at(
      (
        await db.query<CatalogPoi>(textSql(true), [
          ...base,
          input.latitude - dLat,
          input.latitude + dLat,
          input.longitude - dLon,
          input.longitude + dLon,
        ])
      ).rows,
    );
    const merged = new Map<string, CatalogPoi>();
    const add = (rows: CatalogPoi[]) => {
      for (const row of rows) if (!merged.has(row.wolfari_key)) merged.set(row.wolfari_key, row);
      return [...merged.values()].filter(isGood).length >= 3;
    };
    const done = () => ({
      snapshot,
      rows: [...merged.values()].sort(compareHits).slice(0, limit),
      truncated: false,
    });
    if (add(local)) return done();
    if (add(at((await db.query<CatalogPoi>(textSql(false), base)).rows))) return done();
    // Last resort before Geoapify: fuzzy word match nationwide, stricter threshold for this statement.
    const fuzzySql = textSql(false, true);
    const fuzzy = db.withTransaction
      ? await db.withTransaction(async (client) => {
          await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${FUZZY_WORD_SIMILARITY}`);
          return (await client.query<CatalogPoi>(fuzzySql, base)).rows;
        })
      : (await db.query<CatalogPoi>(fuzzySql, base)).rows;
    add(at(fuzzy));
    return done();
  }
  const { dLat, dLon } = box(input.latitude, input.radius);
  const rows = at(
    (
      await db.query<CatalogPoi>(NEARBY_SQL, [
        codes,
        input.latitude,
        input.longitude,
        input.radius,
        input.latitude - dLat,
        input.latitude + dLat,
        input.longitude - dLon,
        input.longitude + dLon,
        snapshot.id,
        limit,
      ])
    ).rows,
  );
  return { snapshot, rows, truncated: false };
}

/** Signed-selection snapshot for a catalogue hit; provider_place_id = wolfari_key. */
export function catalogSnapshot(poi: CatalogPoi): PlaceSnapshot {
  return {
    provider: 'WOLFARI',
    provider_place_id: poi.wolfari_key,
    name: poi.name_vi,
    address: poi.address ?? '',
    latitude: poi.latitude,
    longitude: poi.longitude,
    categories: [poi.category],
    fetched_at: new Date(poi.fetched_at ?? poi.snapshot_at).toISOString(),
    attribution: poi.attribution ?? CATALOG_ATTRIBUTION,
  };
}

/** Lowercase, strip Vietnamese diacritics (đ → d) and punctuation. */
export function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
/** Geoapify hit duplicates a catalogue POI: within 75 m and the same name once accents are removed. */
export function duplicatesCatalog(place: PlaceSnapshot, catalog: readonly CatalogPoi[]): boolean {
  const name = foldName(place.name);
  if (!name) return false;
  return catalog.some((poi) => {
    if (distanceMeters(place.latitude, place.longitude, poi.latitude, poi.longitude) > 75)
      return false;
    return [poi.name_vi, poi.name_en ?? '', ...poi.aliases].some((candidate) => {
      const other = foldName(candidate);
      if (!other) return false;
      if (other === name) return true;
      const [short, long] = other.length < name.length ? [other, name] : [name, other];
      return short.length >= 4 && ` ${long} `.includes(` ${short} `);
    });
  });
}
