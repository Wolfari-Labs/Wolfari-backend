#!/usr/bin/env node
// POI-OVERTURE O4 (database stage): load a build into travel_db as a NEW, INACTIVE snapshot.
// Usage: node scripts/poi/overture-load.mjs --release <R> --golden-snapshot <version>
//          [--build <dir>] [--env <travel .env>] [--batch 100000] [--replace]
//
// The snapshot holds every golden POI of --golden-snapshot copied unchanged (key, coordinates,
// tier, coord_verified, sources) plus the Overture POIs of the build. Overture rows reach
// Postgres through DuckDB's postgres extension (binary COPY) into an UNLOGGED staging table,
// then move into `pois` in batches; search_text uses the same lower(unaccent(...)) as golden.
// The snapshot is marked status=loading until the end, and poi:activate refuses such snapshots.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import { root } from '../config.mjs';
import { safeError } from '../migrations.mjs';
import { DEFAULT_ENV, connectTravel, findSnapshot, travelUrl } from './poi-db.mjs';

const parseCli = () => parseArgs({
  options: {
    release: { type: 'string' },
    'golden-snapshot': { type: 'string' },
    build: { type: 'string' },
    env: { type: 'string', default: DEFAULT_ENV },
    batch: { type: 'string', default: '100000' },
    replace: { type: 'boolean', default: false },
    date: { type: 'string' },
  },
});

export const OVERTURE_LICENSE_FALLBACK = 'CDLA-Permissive-2.0';
/** POIs sharing one exact coordinate from this count on are flagged coord_pileup. */
export const PILEUP_MIN = 20;
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlPath = (path) => sqlString(path.replaceAll('\\', '/'));
const seconds = (from) => Number(((performance.now() - from) / 1000).toFixed(1));
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Snapshot version: golden-overture-vn-<release>-<yyyymmdd> (40 chars, fits varchar(40)). */
export function overtureSnapshotVersion(release, date = new Date()) {
  const ymd = typeof date === 'string' ? date : date.toISOString().slice(0, 10).replaceAll('-', '');
  if (!/^\d{8}$/.test(ymd)) throw new Error('--date phải dạng yyyymmdd');
  const version = `golden-overture-vn-${release}-${ymd}`;
  if (version.length > 40) throw new Error(`Tên snapshot quá 40 ký tự: ${version}`);
  return version;
}

async function main() {
  const { values: args } = parseCli();
  const release = args.release;
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release ?? '')) throw new Error('Cần --release <YYYY-MM-DD.n>');
  if (!args['golden-snapshot']) throw new Error('Cần --golden-snapshot <version>');
  const batch = Number(args.batch);
  if (!Number.isInteger(batch) || batch < 1000) throw new Error('--batch ≥ 1000');
  const buildDir = resolve(args.build ?? resolve(root, `.local/poi/overture/build-${release}`));
  const build = JSON.parse(await readFile(resolve(buildDir, 'manifest.json'), 'utf8'));
  if (build.release !== release) throw new Error(`Build là của release ${build.release}`);
  const poisPath = resolve(buildDir, 'pois.parquet');
  if ((await sha256(poisPath)) !== build.outputs.pois.sha256) throw new Error('pois.parquet khác manifest build');
  const version = overtureSnapshotVersion(release, args.date);
  const url = await travelUrl(args.env);
  const started = performance.now();

  const client = await connectTravel(url, { statementTimeout: '30min' });
  const duck = await (await DuckDBInstance.create(':memory:')).connect();
  let snapshotId;
  const stage = `poi_stage_${Date.now().toString(36)}`;
  const stageSources = `${stage}_src`;
  try {
    // Modest per-session memory: the dev machine has little free RAM.
    await client.query("SET work_mem = '16MB'");
    await client.query("SET maintenance_work_mem = '128MB'");
    const v005 = await client.query("SELECT 1 FROM schema_migrations WHERE version = 'V005'");
    if (!v005.rowCount) throw new Error('Cần cấu hình travel_db V005: chạy migrate travel trước.');
    const golden = await findSnapshot(client, args['golden-snapshot']);
    if (golden.status !== 'complete') throw new Error(`Snapshot golden ${golden.version} chưa hoàn tất.`);

    const existing = (await client.query('SELECT id, is_active FROM poi_snapshots WHERE version = $1', [version])).rows[0];
    if (existing?.is_active) throw new Error(`Snapshot ${version} đang active; không ghi đè.`);
    if (existing && !args.replace) throw new Error(`Snapshot ${version} đã tồn tại (inactive); thêm --replace để nạp lại.`);
    if (existing) {
      console.log(`Xóa snapshot inactive cũ ${version} để nạp lại…`);
      await client.query('DELETE FROM poi_snapshots WHERE id = $1 AND NOT is_active', [existing.id]);
    }

    const manifest = {
      kind: 'golden+overture',
      status: 'loading',
      release,
      golden_snapshot: golden.version,
      build: { counts: build.counts, rules: build.rules, raw: build.raw, pois: build.outputs.pois, provinces: build.provinces.source },
      license: 'mixed (per POI)',
      attribution: '© Overture Maps Foundation; © OpenStreetMap contributors (golden)',
      loader: 'scripts/poi/overture-load.mjs',
      loaded_at: new Date().toISOString(),
    };
    snapshotId = (
      await client.query('INSERT INTO poi_snapshots(version, manifest, is_active) VALUES ($1, $2::jsonb, false) RETURNING id', [
        version,
        JSON.stringify(manifest),
      ])
    ).rows[0].id;
    console.log(`Snapshot ${version} (inactive, loading)`);

    // ---- golden: copy unchanged, add province_code and source_dataset ----------------------
    let t = performance.now();
    await duck.run('INSTALL postgres');
    await duck.run('LOAD postgres');
    const goldenProvinces = (await duck.runAndReadAll(`SELECT wolfari_key, province_code FROM read_parquet(${sqlPath(resolve(buildDir, 'golden-provinces.parquet'))})`)).getRowObjects();
    const goldenSources = (await duck.runAndReadAll(`SELECT wolfari_key, gers_id, license FROM read_parquet(${sqlPath(resolve(buildDir, 'golden-sources.parquet'))})`)).getRowObjects();
    const fetchedAt = build.fetched_at;
    await client.query('BEGIN');
    const copied = await client.query(
      `INSERT INTO pois(snapshot_id, wolfari_key, tier, name_vi, name_en, aliases, search_text, category, tags,
         latitude, longitude, coord_verified, province_code, address, opening_hours, hours_verified,
         typical_duration_min, indoor, dress_code_hint, activity_type, ticket_vnd_min, ticket_vnd_max,
         confidence, popularity, license, attribution, source_dataset)
       SELECT $1, p.wolfari_key, p.tier, p.name_vi, p.name_en, p.aliases, p.search_text, p.category, p.tags,
         p.latitude, p.longitude, p.coord_verified, coalesce(gp.province_code, p.province_code), p.address,
         p.opening_hours, p.hours_verified, p.typical_duration_min, p.indoor, p.dress_code_hint, p.activity_type,
         p.ticket_vnd_min, p.ticket_vnd_max, p.confidence, p.popularity, p.license, p.attribution, 'golden'
       FROM pois p
       LEFT JOIN jsonb_to_recordset($3::jsonb) AS gp(wolfari_key text, province_code text) USING (wolfari_key)
       WHERE p.snapshot_id = $2`,
      [snapshotId, golden.id, JSON.stringify(goldenProvinces)],
    );
    await client.query(
      `INSERT INTO poi_sources(poi_id, source, source_id, license, fetched_at)
       SELECT n.id, s.source, s.source_id, s.license, s.fetched_at
       FROM poi_sources s JOIN pois o ON o.id = s.poi_id AND o.snapshot_id = $2
       JOIN pois n ON n.snapshot_id = $1 AND n.wolfari_key = o.wolfari_key`,
      [snapshotId, golden.id],
    );
    const goldenOverture = await client.query(
      `INSERT INTO poi_sources(poi_id, source, source_id, license, fetched_at)
       SELECT n.id, 'overture', g.gers_id, left(coalesce(nullif(g.license, ''), $4), 40), $3::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS g(wolfari_key text, gers_id text, license text)
       JOIN pois n ON n.snapshot_id = $1 AND n.wolfari_key = g.wolfari_key
       ON CONFLICT DO NOTHING`,
      [snapshotId, JSON.stringify(goldenSources), fetchedAt, OVERTURE_LICENSE_FALLBACK],
    );
    await client.query('COMMIT');
    console.log(`  golden: ${copied.rowCount} POI, +${goldenOverture.rowCount} nguồn Overture (${seconds(t)} s)`);

    // ---- Overture: parquet → staging (binary COPY) → pois in batches ----------------------
    t = performance.now();
    await client.query(`CREATE UNLOGGED TABLE ${stage} (
      n bigint NOT NULL, wolfari_key varchar(120) NOT NULL, name_vi varchar(255) NOT NULL, name_en varchar(255),
      aliases text[] NOT NULL, address_short text, category varchar(40) NOT NULL, activity_type varchar(40),
      latitude numeric(9,6) NOT NULL, longitude numeric(9,6) NOT NULL, province_code varchar(10) NOT NULL,
      address text, confidence numeric(4,3) NOT NULL, license varchar(40) NOT NULL, attribution text NOT NULL)`);
    await client.query(`CREATE UNLOGGED TABLE ${stageSources} (
      wolfari_key varchar(120) NOT NULL, gers_id varchar(255) NOT NULL, license varchar(40) NOT NULL)`);
    await duck.run(`ATTACH ${sqlString(url)} AS pg (TYPE postgres)`);
    await duck.run(`INSERT INTO pg.public.${stage}
      SELECT row_number() OVER (ORDER BY province_code, wolfari_key) - 1, wolfari_key,
        left(name_vi, 255), left(name_en, 255), list_transform(coalesce(aliases, []), a -> left(a, 255)), address_short,
        category, activity_type, latitude, longitude, province_code, address, confidence,
        coalesce(nullif(license, ''), ${sqlString(OVERTURE_LICENSE_FALLBACK)}), attribution
      FROM read_parquet(${sqlPath(poisPath)})`);
    await duck.run(`INSERT INTO pg.public.${stageSources}
      SELECT wolfari_key, s.gers_id, left(coalesce(nullif(s.license, ''), ${sqlString(OVERTURE_LICENSE_FALLBACK)}), 40)
      FROM (SELECT wolfari_key, unnest(sources) AS s FROM read_parquet(${sqlPath(poisPath)}))`);
    await duck.run('DETACH pg');
    const total = Number((await client.query(`SELECT count(*) AS n FROM ${stage}`)).rows[0].n);
    console.log(`  staging: ${total} POI (${seconds(t)} s)`);

    t = performance.now();
    let loaded = 0;
    for (let from = 0; from < total; from += batch) {
      const inserted = await client.query(
        `INSERT INTO pois(snapshot_id, wolfari_key, tier, name_vi, name_en, aliases, search_text, category,
           latitude, longitude, coord_verified, province_code, address, activity_type, confidence, popularity,
           license, attribution, source_dataset, source_release, fetched_at)
         SELECT $1, wolfari_key, 9, name_vi, name_en, aliases,
           lower(unaccent(concat_ws(' ', name_vi::text, name_en::text, array_to_string(aliases, ' '), address_short))),
           category, latitude, longitude, false, province_code, address, activity_type, confidence, 0,
           license, attribution, 'overture', $2, $3::timestamptz
         FROM ${stage} WHERE n >= $4 AND n < $5`,
        [snapshotId, release, fetchedAt, from, from + batch],
      );
      loaded += inserted.rowCount;
      console.log(`  pois ${loaded}/${total} (${seconds(t)} s)`);
    }
    const sources = await client.query(
      `INSERT INTO poi_sources(poi_id, source, source_id, license, fetched_at)
       SELECT p.id, 'overture', s.gers_id, s.license, $2::timestamptz
       FROM ${stageSources} s JOIN pois p ON p.snapshot_id = $1 AND p.wolfari_key = s.wolfari_key`,
      [snapshotId, fetchedAt],
    );
    console.log(`  poi_sources Overture: ${sources.rowCount} (${seconds(t)} s)`);
    await client.query(`DROP TABLE ${stage}`);
    await client.query(`DROP TABLE ${stageSources}`);
    // Coordinate pile-ups: ≥ PILEUP_MIN Overture POIs on one exact coordinate (area centroids).
    // Kept for name search, hidden from map exploration; golden POIs are never flagged.
    t = performance.now();
    const pileup = await client.query(
      `UPDATE pois p SET coord_pileup = true
       FROM (SELECT latitude, longitude FROM pois WHERE snapshot_id = $1 AND tier = 9
             GROUP BY 1, 2 HAVING count(*) >= $2) c
       WHERE p.snapshot_id = $1 AND p.tier = 9 AND p.latitude = c.latitude AND p.longitude = c.longitude`,
      [snapshotId, PILEUP_MIN],
    );
    console.log(`  coord_pileup: ${pileup.rowCount} POI (${seconds(t)} s)`);
    t = performance.now();
    await client.query('ANALYZE pois');
    await client.query('ANALYZE poi_sources');
    await client.query('ANALYZE poi_snapshots');
    console.log(`  ANALYZE (${seconds(t)} s)`);

    manifest.status = 'complete';
    manifest.counts = {
      golden: copied.rowCount,
      golden_overture_sources: goldenOverture.rowCount,
      overture: loaded,
      overture_sources: sources.rowCount,
      coord_pileup: pileup.rowCount,
      total: copied.rowCount + loaded,
    };
    manifest.coord_pileup_min = PILEUP_MIN;
    manifest.seconds = seconds(started);
    await client.query('UPDATE poi_snapshots SET manifest = $2::jsonb WHERE id = $1', [snapshotId, JSON.stringify(manifest)]);
    console.log(`Xong: ${version} · ${manifest.counts.total} POI · ${manifest.seconds} s · CHƯA active`);
    console.log(`Kích hoạt: corepack pnpm poi:activate ${version}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP TABLE IF EXISTS ${stage}`).catch(() => {});
    await client.query(`DROP TABLE IF EXISTS ${stageSources}`).catch(() => {});
    if (snapshotId) console.error(`Snapshot ${version} dừng ở status=loading; chạy lại với --replace.`);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/poi/overture-load.mjs'))
  main().catch((error) => {
    const message = String(error?.message ?? '');
    console.error(/^(Cần|Snapshot|Build|Không|Tên snapshot|--)/.test(message) ? message : safeError(error));
    process.exitCode = 1;
  });
