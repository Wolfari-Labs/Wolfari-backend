import {
  POI_SEARCH_CATEGORIES,
  type PlaceSearchCategory,
  type PlaceSnapshot,
} from '@wolfari/common';
import type { DatabaseProvider } from '@wolfari/database';

/** A curated POI row from the active snapshot (travel_db V003). */
export type CatalogPoi = {
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
  snapshot_at: Date;
  sim: number | null;
  distance_m: number;
};
type Queryable = Pick<DatabaseProvider, 'query'>;

export const CATALOG_ATTRIBUTION = '© OpenStreetMap contributors';
/** A catalogue hit counts as "good enough" to skip Geoapify at this similarity. */
export const GOOD_SIMILARITY = 0.3;
const LIMIT = 20;

const DISTANCE_SQL = `(2 * 6371000 * asin(sqrt(
  power(sin(radians(p.latitude::float8 - $LAT) / 2), 2) +
  cos(radians($LAT)) * cos(radians(p.latitude::float8)) *
  power(sin(radians(p.longitude::float8 - $LON) / 2), 2))))`;
const COLUMNS = `p.wolfari_key, p.tier, p.name_vi, p.name_en, p.aliases, p.category,
  p.latitude::float8 AS latitude, p.longitude::float8 AS longitude, p.coord_verified, p.address,
  p.typical_duration_min, p.activity_type, p.dress_code_hint, p.attribution, s.created_at AS snapshot_at`;

/** Text search over the whole active snapshot (accent-insensitive), nearest wins ties. */
const TEXT_SQL = `WITH q AS (
  SELECT t, replace(replace(replace(t, '\\', '\\\\'), '%', '\\%'), '_', '\\_') AS pattern
  FROM (SELECT lower(unaccent($1::text)) AS t) raw
)
SELECT * FROM (
  SELECT ${COLUMNS},
    GREATEST(similarity(p.search_text, q.t), word_similarity(q.t, p.search_text))::float8 AS sim,
    ${DISTANCE_SQL.replaceAll('$LAT', '$3').replaceAll('$LON', '$4')} AS distance_m,
    (CASE WHEN p.tier IN (1, 2, 3) THEN 0.3 ELSE 0 END)
      + GREATEST(similarity(p.search_text, q.t), word_similarity(q.t, p.search_text))
      + CASE WHEN EXISTS (
          SELECT 1 FROM unnest(p.aliases || ARRAY[p.name_vi::text, coalesce(p.name_en, '')::text]) n
          WHERE lower(unaccent(n)) = q.t) THEN 1 ELSE 0 END
      + 0.1 * p.popularity::float8 AS score
  FROM pois p
  JOIN poi_snapshots s ON s.id = p.snapshot_id AND s.is_active
  CROSS JOIN q
  WHERE p.category = ANY($2::text[])
    AND (p.search_text LIKE '%' || q.pattern || '%' OR word_similarity(q.t, p.search_text) > 0.3)
) hit
ORDER BY score DESC, tier, distance_m, wolfari_key
LIMIT ${LIMIT}`;

/** No text: catalogue points within radius_m of the center, by tier then distance. */
const NEARBY_SQL = `SELECT * FROM (
  SELECT ${COLUMNS}, NULL::float8 AS sim,
    ${DISTANCE_SQL.replaceAll('$LAT', '$2').replaceAll('$LON', '$3')} AS distance_m
  FROM pois p
  JOIN poi_snapshots s ON s.id = p.snapshot_id AND s.is_active
  WHERE p.category = ANY($1::text[])
    AND p.latitude BETWEEN $5 AND $6 AND p.longitude BETWEEN $7 AND $8
) near
WHERE distance_m <= $4
ORDER BY tier, distance_m, wolfari_key
LIMIT ${LIMIT}`;

export interface CatalogQuery {
  query: string;
  latitude: number;
  longitude: number;
  radius: number;
  category: string;
}
export async function searchCatalog(db: Queryable, input: CatalogQuery): Promise<CatalogPoi[]> {
  const categories = POI_SEARCH_CATEGORIES[input.category as PlaceSearchCategory] ?? [];
  if (!categories.length) return [];
  const text = input.query.replace(/\s+/g, ' ').trim();
  if (text) {
    return (
      await db.query<CatalogPoi>(TEXT_SQL, [text, categories, input.latitude, input.longitude])
    ).rows;
  }
  const dLat = input.radius / 111320;
  const dLon = input.radius / (111320 * Math.max(Math.cos((input.latitude * Math.PI) / 180), 0.01));
  return (
    await db.query<CatalogPoi>(NEARBY_SQL, [
      categories,
      input.latitude,
      input.longitude,
      input.radius,
      input.latitude - dLat,
      input.latitude + dLat,
      input.longitude - dLon,
      input.longitude + dLon,
    ])
  ).rows;
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
    fetched_at: new Date(poi.snapshot_at).toISOString(),
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
