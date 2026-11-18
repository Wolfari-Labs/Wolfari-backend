#!/usr/bin/env node
// Load data/poi/danang_golden.csv into travel_db as a new active POI snapshot (MAP-POI B3).
// Usage: corepack pnpm poi:load [--csv <path>] [--overrides <path> | --no-overrides] [--dry-run]
// Reviewer overrides (data/poi/danang_golden.overrides.csv) win over the golden CSV; any invalid
// override aborts the load. Invalid golden rows are printed and skipped; nothing is guessed.
// One transaction: the previous snapshot stays active until the new one is fully inserted.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { root, readEnv } from '../config.mjs';
import { connectDatabase, safeError } from '../migrations.mjs';
import { parseCsv } from './csv.mjs';
import { DANANG_BBOX, applyOverride, parseOverrides } from './overrides.mjs';

const require = createRequire(import.meta.url);
let taxonomy;
try {
  taxonomy = require('../../packages/common/dist/poi-taxonomy.js');
} catch {
  console.error(
    'Thiếu bản build @wolfari/common; chạy qua `corepack pnpm poi:load` để build trước.',
  );
  process.exit(1);
}
const { isPoiCategory, POI_ACTIVITY_TYPES } = taxonomy;

export { DANANG_BBOX };
const LICENSE = 'ODbL-1.0';
const ATTRIBUTION = '© OpenStreetMap contributors';
const flag = (value) =>
  value === 'true' ? true : value === 'false' || value === '' ? false : null;

/** Validate one CSV record; returns { row } or { errors }. */
export function validateRow(record, seen) {
  const errors = [];
  const key = record.wolfari_key?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,119}$/.test(key)) errors.push('wolfari_key không hợp lệ');
  else if (seen.has(key)) errors.push('wolfari_key bị trùng');
  const tier = Number(record.tier);
  if (![1, 2, 3].includes(tier)) errors.push(`tier phải là 1, 2 hoặc 3 (đang là "${record.tier}")`);
  const nameVi = record.name_vi?.trim() ?? '';
  const nameEn = record.name_en?.trim() ?? '';
  if (!nameVi || nameVi.length > 255) errors.push('name_vi trống hoặc quá 255 ký tự');
  if (nameEn.length > 255) errors.push('name_en quá 255 ký tự');
  const category = record.category?.trim() ?? '';
  if (!isPoiCategory(category)) errors.push(`category "${category}" không thuộc taxonomy mục 8`);
  const latText = record.lat?.trim() ?? '';
  const lonText = record.lon?.trim() ?? '';
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!latText || !lonText) errors.push('thiếu lat/lon');
  else if (!Number.isFinite(lat) || !Number.isFinite(lon)) errors.push('lat/lon không phải số');
  else if (
    lat < DANANG_BBOX.minLat ||
    lat > DANANG_BBOX.maxLat ||
    lon < DANANG_BBOX.minLon ||
    lon > DANANG_BBOX.maxLon
  )
    errors.push(`(${lat}, ${lon}) nằm ngoài bbox Đà Nẵng`);
  const durationText = record.typical_duration_min?.trim() ?? '';
  const duration = durationText ? Number(durationText) : null;
  if (duration !== null && (!Number.isInteger(duration) || duration <= 0))
    errors.push('typical_duration_min phải là số nguyên dương');
  const indoor = record.indoor?.trim() ? flag(record.indoor.trim()) : null;
  if (record.indoor?.trim() && indoor === null) errors.push('indoor phải là true/false');
  const coordVerified = flag(record.coord_verified?.trim() ?? '');
  const hoursVerified = flag(record.hours_verified?.trim() ?? '');
  if (coordVerified === null) errors.push('coord_verified phải là true/false');
  if (hoursVerified === null) errors.push('hours_verified phải là true/false');
  const activityType = record.activity_type?.trim() ?? '';
  if (activityType.length > 40) errors.push('activity_type quá 40 ký tự');
  const dressCode = record.dress_code_hint?.trim() ?? '';
  if (dressCode.length > 120) errors.push('dress_code_hint quá 120 ký tự');
  const osmRef = record.osm_ref?.trim() ?? '';
  if (osmRef && !/^(node|way|relation)\/\d+$/.test(osmRef))
    errors.push(`osm_ref "${osmRef}" không hợp lệ`);
  if (errors.length) return { errors };
  seen.add(key);
  const warnings = [];
  if (activityType && !POI_ACTIVITY_TYPES.includes(activityType))
    warnings.push(`activity_type "${activityType}" ngoài danh sách; web hiển thị "Khác"`);
  return {
    warnings,
    row: {
      wolfari_key: key,
      tier,
      name_vi: nameVi,
      name_en: nameEn || null,
      aliases: (record.aliases ?? '')
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean),
      category,
      latitude: lat.toFixed(6),
      longitude: lon.toFixed(6),
      coord_verified: coordVerified,
      opening_hours: record.opening_hours?.trim() || null,
      hours_verified: hoursVerified,
      typical_duration_min: duration,
      indoor,
      dress_code_hint: dressCode || null,
      activity_type: activityType || null,
      osm_ref: osmRef || null,
      coord_source: record.coord_source?.trim() || null,
    },
  };
}

function snapshotVersion(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const base = `golden-danang-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
  return { base, withSeconds: `${base}${parts.second}` };
}

async function main() {
  const args = process.argv.slice(2);
  const csvPath = resolve(
    root,
    args.includes('--csv') ? args[args.indexOf('--csv') + 1] : 'data/poi/danang_golden.csv',
  );
  const dryRun = args.includes('--dry-run');
  const bytes = await readFile(csvPath);
  const { records: original } = parseCsv(bytes.toString('utf8'));
  const overridePath = args.includes('--no-overrides')
    ? null
    : resolve(
        root,
        args.includes('--overrides')
          ? args[args.indexOf('--overrides') + 1]
          : csvPath.replace(/\.csv$/, '.overrides.csv'),
      );
  let overrides = new Map();
  let overrideBytes = null;
  if (overridePath && existsSync(overridePath)) {
    overrideBytes = await readFile(overridePath);
    const parsed = parseOverrides(
      overrideBytes.toString('utf8'),
      new Set(original.map((r) => r.wolfari_key)),
    );
    if (parsed.errors.length) {
      for (const error of parsed.errors) console.log(`OVERRIDE LỖI ${error}`);
      throw new Error(
        `File override có lỗi: sửa ${parsed.errors.length} lỗi trong ${relative(root, overridePath)} rồi chạy lại; chưa nạp gì.`,
      );
    }
    overrides = parsed.overrides;
    for (const [key, o] of overrides)
      console.log(
        `OVERRIDE ${key}: ${o.lat ? `${o.lat}, ${o.lon}` : 'giữ ghim'}${o.coord_verified !== undefined ? ` · coord_verified=${o.coord_verified}` : ''}${o.note ? ` · ${o.note}` : ''}`,
      );
  }
  const records = original.map((r) => applyOverride(r, overrides.get(r.wolfari_key)));
  const seen = new Set();
  const rows = [];
  const rejected = [];
  for (const [index, record] of records.entries()) {
    const result = validateRow(record, seen);
    const label = record.wolfari_key || `dòng ${index + 2}`;
    if (result.errors) {
      rejected.push({ key: label, errors: result.errors });
      console.log(`BỎ QUA ${label}: ${result.errors.join('; ')}`);
      continue;
    }
    for (const warning of result.warnings) console.log(`CẢNH BÁO ${label}: ${warning}`);
    rows.push(result.row);
  }
  const verified = rows.filter((r) => r.coord_verified).length;
  console.log(
    `\nHợp lệ ${rows.length}/${records.length} · bỏ qua ${rejected.length} · đã xác minh tọa độ ${verified}`,
  );
  if (!rows.length) throw new Error('Không có dòng hợp lệ nào để nạp.');
  if (dryRun) {
    console.log('--dry-run: không ghi database.');
    return;
  }

  const env = await readEnv(resolve(root, 'apps/travel-intelligence-service/.env'));
  if (!env.DATABASE_URL)
    throw new Error(
      'Thiếu cấu hình DATABASE_URL trong apps/travel-intelligence-service/.env; chạy pnpm env:init.',
    );
  const client = await connectDatabase('travel', env.DATABASE_URL);
  try {
    const migrated = await client.query("SELECT 1 FROM schema_migrations WHERE version='V003'");
    if (!migrated.rowCount)
      throw new Error(
        'Cần cấu hình travel_db V003: chạy `corepack pnpm db:migrate --service travel`.',
      );
    const { base, withSeconds } = snapshotVersion();
    const taken = await client.query('SELECT 1 FROM poi_snapshots WHERE version=$1', [base]);
    const version = taken.rowCount ? withSeconds : base;
    const manifest = {
      kind: 'golden',
      region: 'danang',
      source_file: relative(root, csvPath).replaceAll('\\', '/'),
      source_sha256: createHash('sha256').update(bytes).digest('hex'),
      rows_total: records.length,
      rows_loaded: rows.length,
      coord_verified: verified,
      rejected,
      overrides: overrideBytes
        ? {
            source_file: relative(root, overridePath).replaceAll('\\', '/'),
            source_sha256: createHash('sha256').update(overrideBytes).digest('hex'),
            applied: [...overrides.keys()],
          }
        : null,
      license: LICENSE,
      attribution: ATTRIBUTION,
      loader: 'scripts/poi/load-golden.mjs',
      loaded_at: new Date().toISOString(),
    };
    await client.query('BEGIN');
    try {
      const snapshot = (
        await client.query(
          'INSERT INTO poi_snapshots(version,manifest,is_active) VALUES($1,$2::jsonb,false) RETURNING id',
          [version, JSON.stringify(manifest)],
        )
      ).rows[0].id;
      for (const row of rows) {
        const poi = (
          await client.query(
            `INSERT INTO pois(snapshot_id,wolfari_key,tier,name_vi,name_en,aliases,search_text,category,latitude,longitude,
               coord_verified,opening_hours,hours_verified,typical_duration_min,indoor,dress_code_hint,activity_type,
               confidence,license,attribution)
             VALUES($1,$2,$3,$4::text,$5::text,$6::text[],
               lower(unaccent(concat_ws(' ', $4::text, $5::text, array_to_string($6::text[], ' ')))),
               $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1.0,$17,$18)
             RETURNING id`,
            [
              snapshot,
              row.wolfari_key,
              row.tier,
              row.name_vi,
              row.name_en,
              row.aliases,
              row.category,
              row.latitude,
              row.longitude,
              row.coord_verified,
              row.opening_hours,
              row.hours_verified,
              row.typical_duration_min,
              row.indoor,
              row.dress_code_hint,
              row.activity_type,
              LICENSE,
              ATTRIBUTION,
            ],
          )
        ).rows[0].id;
        if (row.osm_ref)
          await client.query(
            "INSERT INTO poi_sources(poi_id,source,source_id,license,fetched_at) VALUES($1,'osm',$2,$3,now())",
            [poi, row.osm_ref, LICENSE],
          );
        else if (row.coord_source === 'manual')
          // Reviewer-entered coordinate (typically read off the OSM map): keep provenance explicit.
          await client.query(
            "INSERT INTO poi_sources(poi_id,source,source_id,license,fetched_at) VALUES($1,'manual',$2,$3,now())",
            [poi, overrides.has(row.wolfari_key) ? 'overrides.csv' : 'golden.csv', LICENSE],
          );
      }
      await client.query('UPDATE poi_snapshots SET is_active=false WHERE is_active AND id<>$1', [
        snapshot,
      ]);
      await client.query('UPDATE poi_snapshots SET is_active=true WHERE id=$1', [snapshot]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    console.log(
      `Đã nạp snapshot ${version} (${rows.length} điểm, ${verified} đã xác minh, ${overrides.size} override) và đặt làm snapshot active.`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/poi/load-golden.mjs'))
  main().catch((error) => {
    const message = String(error?.message ?? '');
    // Own messages are safe; driver errors go through safeError (no SQL/URL/credentials).
    console.error(
      /^(Không có|Thiếu|Cần cấu hình|CSV:|File override)/.test(message)
        ? message
        : safeError(error),
    );
    process.exitCode = 1;
  });
