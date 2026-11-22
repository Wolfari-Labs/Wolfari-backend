// Human-reviewed coordinate overrides for the golden list (data/poi/danang_golden.overrides.csv).
// Pure helpers: no I/O, no database. The reviewer decides; nothing here guesses a coordinate.
import { parseCsv } from './csv.mjs';

export const DANANG_BBOX = Object.freeze({
  minLat: 14.9,
  maxLat: 16.4,
  minLon: 107.2,
  maxLon: 108.8,
});
export const OVERRIDE_HEADER = Object.freeze([
  'wolfari_key',
  'lat',
  'lon',
  'coord_verified',
  'note',
]);

/**
 * Parse overrides. A row with lat, lon and coord_verified all empty is an unused template row.
 * Returns { overrides: Map<key, {lat?, lon?, coord_verified?, note}>, errors: string[] }.
 */
export function parseOverrides(text, knownKeys) {
  const { header, records } = parseCsv(text);
  const errors = [];
  if (
    OVERRIDE_HEADER.some((column, i) => header[i] !== column) ||
    header.length !== OVERRIDE_HEADER.length
  )
    return { overrides: new Map(), errors: [`header phải đúng: ${OVERRIDE_HEADER.join(',')}`] };
  const overrides = new Map();
  for (const [index, record] of records.entries()) {
    const line = `dòng ${index + 2}`;
    const key = record.wolfari_key.trim();
    const latText = record.lat.trim();
    const lonText = record.lon.trim();
    const verifiedText = record.coord_verified.trim().toLowerCase();
    const note = record.note.trim();
    if (!latText && !lonText && !verifiedText) continue;
    const rowErrors = [];
    if (!knownKeys.has(key)) rowErrors.push(`wolfari_key "${key}" không có trong golden list`);
    if (overrides.has(key)) rowErrors.push(`wolfari_key "${key}" bị khai báo hai lần`);
    if (Boolean(latText) !== Boolean(lonText))
      rowErrors.push('phải điền cả lat và lon (hoặc để trống cả hai)');
    let lat;
    let lon;
    if (latText && lonText) {
      lat = Number(latText.replace(',', '.'));
      lon = Number(lonText.replace(',', '.'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) rowErrors.push('lat/lon không phải số');
      else if (
        lat < DANANG_BBOX.minLat ||
        lat > DANANG_BBOX.maxLat ||
        lon < DANANG_BBOX.minLon ||
        lon > DANANG_BBOX.maxLon
      )
        rowErrors.push(`(${lat}, ${lon}) nằm ngoài bbox Đà Nẵng — kiểm thứ tự lat, lon`);
    }
    if (verifiedText && !['true', 'false'].includes(verifiedText))
      rowErrors.push('coord_verified phải là true, false hoặc để trống');
    if (rowErrors.length) {
      errors.push(`${line} (${key || '?'}): ${rowErrors.join('; ')}`);
      continue;
    }
    overrides.set(key, {
      ...(latText ? { lat: lat.toFixed(6), lon: lon.toFixed(6) } : {}),
      ...(verifiedText ? { coord_verified: verifiedText === 'true' } : {}),
      note,
    });
  }
  return { overrides, errors };
}

/**
 * Apply one override to a golden CSV record (returns a new record).
 * New coordinates become coord_source=manual and drop the Nominatim osm_ref; coord_verified
 * stays false unless the reviewer wrote true.
 */
export function applyOverride(record, override) {
  if (!override) return record;
  const next = { ...record };
  if (override.lat !== undefined) {
    next.lat = override.lat;
    next.lon = override.lon;
    next.coord_source = 'manual';
    next.osm_ref = '';
    next.coord_verified = 'false';
  }
  if (override.coord_verified !== undefined) next.coord_verified = String(override.coord_verified);
  return next;
}

export function overrideTemplate(records) {
  return records.map((r) => ({
    wolfari_key: r.wolfari_key,
    lat: '',
    lon: '',
    coord_verified: '',
    note: '',
  }));
}
