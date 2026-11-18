// db:test check for POI-OVERTURE: load a tiny build as an inactive snapshot, then
// poi:snapshots / poi:activate in both directions. Runs against the isolated test database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { root } from './config.mjs';

const RELEASE = '2026-10-21.0';
const VERSION = `golden-overture-vn-${RELEASE}-20991231`;

function run(script, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, script), ...args], { cwd: root, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => done({ code, out }));
  });
}

async function writeBuild(dir) {
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  const p = (name) => `'${resolve(dir, name).replaceAll('\\', '/')}'`;
  await db.run(`COPY (SELECT * FROM (VALUES
      ('ov-a1', 'a1', 'Bún Chả Hương Liên', NULL, ['Obama Bun Cha'], 'restaurant', 'restaurant', 'FOOD', 21.0181, 105.8537, '01', 'polygon',
       '24 Lê Văn Hưu, Hai Bà Trưng', '24 Lê Văn Hưu', 0.91, 'CDLA-Permissive-2.0', '© Overture Maps Foundation; meta (CDLA-Permissive-2.0)',
       [{'gers_id': 'a1', 'license': 'CDLA-Permissive-2.0'}, {'gers_id': 'a1-dup', 'license': 'CDLA-Permissive-2.0'}], 'food_and_drink>restaurant'),
      ('ov-a2', 'a2', 'Hồ Hoàn Kiếm', 'Hoan Kiem Lake', [], 'nature_area', 'tourism', 'OUTDOOR', 21.0287, 105.8524, '01', 'polygon',
       NULL, NULL, 0.77, 'Apache-2.0; CDLA-Permissive-2.0', '© Overture Maps Foundation; Foursquare (Apache-2.0)',
       [{'gers_id': 'a2', 'license': 'Apache-2.0; CDLA-Permissive-2.0'}], 'geographic_entities>water_feature>lake'),
      ('ov-a3', 'a3', 'ATM Vietcombank', NULL, [], 'traveler_service', 'services', NULL, 16.0679, 108.2242, '48', 'coast',
       NULL, NULL, 0.5, 'CDLA-Permissive-2.0', '© Overture Maps Foundation; meta (CDLA-Permissive-2.0)',
       [{'gers_id': 'a3', 'license': 'CDLA-Permissive-2.0'}], 'services_and_business>financial_service>atm')
    ) t(wolfari_key, gers_id, name_vi, name_en, aliases, category, category_group, activity_type, latitude, longitude,
        province_code, located_by, address, address_short, confidence, license, attribution, sources, overture_category))
    TO ${p('pois.parquet')} (FORMAT parquet)`);
  await db.run(`COPY (SELECT * FROM (VALUES ('it-cho-han', '48'), ('it-cau-rong', '48')) t(wolfari_key, province_code))
    TO ${p('golden-provinces.parquet')} (FORMAT parquet)`);
  await db.run(`COPY (SELECT * FROM (VALUES ('it-cho-han', 'g1', 25.0, 0.8, false, 'CDLA-Permissive-2.0', 'Han Market'))
      t(wolfari_key, gers_id, distance_m, sim, alias_hit, license, overture_name))
    TO ${p('golden-sources.parquet')} (FORMAT parquet)`);
  const sha = createHash('sha256').update(await readFile(resolve(dir, 'pois.parquet'))).digest('hex');
  await writeFile(
    resolve(dir, 'manifest.json'),
    JSON.stringify({
      release: RELEASE,
      counts: { new_pois: 3 },
      rules: {},
      raw: {},
      provinces: { source: 'test' },
      fetched_at: '2026-11-18T14:30:00.000Z',
      outputs: { pois: { file: 'pois.parquet', sha256: sha } },
    }),
  );
}

export async function checkOvertureSnapshots(client, url) {
  const dir = await mkdtemp(resolve(tmpdir(), 'wolfari-poi-ov-'));
  const envFile = resolve(dir, 'travel.env');
  await writeFile(envFile, `DATABASE_URL=${url}\n`);
  const created = [];
  const previous = (await client.query('SELECT id FROM poi_snapshots WHERE is_active')).rows[0]?.id ?? null;
  try {
    await client.query('UPDATE poi_snapshots SET is_active = false WHERE is_active');
    const golden = (
      await client.query(`INSERT INTO poi_snapshots(version, manifest, is_active)
        VALUES ('it-golden', '{"kind":"golden"}', true) RETURNING id`)
    ).rows[0].id;
    created.push(golden);
    for (const [key, vi, lat, lon, verified] of [
      ['it-cho-han', 'Chợ Hàn', 16.068352, 108.224283, true],
      ['it-cau-rong', 'Cầu Rồng', 16.061168, 108.227897, false],
    ]) {
      const id = (
        await client.query(
          `INSERT INTO pois(snapshot_id, wolfari_key, tier, name_vi, aliases, search_text, category, latitude, longitude,
             coord_verified, confidence, license, attribution)
           VALUES ($1, $2, 1, $3::text, '{}', lower(unaccent($3::text)), 'market', $4, $5, $6, 1.0, 'ODbL-1.0', '© OpenStreetMap contributors')
           RETURNING id`,
          [golden, key, vi, lat, lon, verified],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO poi_sources(poi_id, source, source_id, license, fetched_at) VALUES ($1, 'osm', $2, 'ODbL-1.0', now())",
        [id, `way/${key}`],
      );
    }
    await writeBuild(dir);
    const load = (extra = []) =>
      run('scripts/poi/overture-load.mjs', ['--release', RELEASE, '--golden-snapshot', 'it-golden', '--build', dir,
        '--env', envFile, '--date', '20991231', '--batch', '1000', ...extra]);

    let result = await load();
    assert.equal(result.code, 0, result.out);
    const snap = (await client.query('SELECT id, is_active, manifest FROM poi_snapshots WHERE version = $1', [VERSION])).rows[0];
    created.push(snap.id);
    assert.equal(snap.is_active, false, 'new snapshot is not active');
    assert.equal(snap.manifest.status, 'complete');
    assert.deepEqual(snap.manifest.counts, { golden: 2, golden_overture_sources: 1, overture: 3, overture_sources: 4, total: 5 });
    const pois = (
      await client.query(
        `SELECT wolfari_key, tier, latitude::float8 AS lat, longitude::float8 AS lon, coord_verified, province_code,
           source_dataset, source_release, search_text, license, confidence::float8 AS confidence
         FROM pois WHERE snapshot_id = $1 ORDER BY wolfari_key`,
        [snap.id],
      )
    ).rows;
    const byKey = Object.fromEntries(pois.map((p) => [p.wolfari_key, p]));
    assert.deepEqual(
      { ...byKey['it-cho-han'], search_text: undefined },
      { wolfari_key: 'it-cho-han', tier: 1, lat: 16.068352, lon: 108.224283, coord_verified: true, province_code: '48',
        source_dataset: 'golden', source_release: null, search_text: undefined, license: 'ODbL-1.0', confidence: 1 },
    );
    assert.equal(byKey['ov-a1'].tier, 9);
    assert.equal(byKey['ov-a1'].coord_verified, false);
    assert.equal(byKey['ov-a1'].source_dataset, 'overture');
    assert.equal(byKey['ov-a1'].source_release, RELEASE);
    assert.equal(byKey['ov-a1'].search_text, 'bun cha huong lien obama bun cha 24 le van huu');
    assert.equal(byKey['ov-a2'].license, 'Apache-2.0; CDLA-Permissive-2.0');
    assert.equal(byKey['ov-a3'].province_code, '48');
    const sources = (
      await client.query(
        `SELECT p.wolfari_key, s.source, s.source_id FROM poi_sources s JOIN pois p ON p.id = s.poi_id
         WHERE p.snapshot_id = $1 ORDER BY 1, 2, 3`,
        [snap.id],
      )
    ).rows.map((r) => `${r.wolfari_key}:${r.source}:${r.source_id}`);
    assert.deepEqual(sources, [
      'it-cau-rong:osm:way/it-cau-rong',
      'it-cho-han:osm:way/it-cho-han',
      'it-cho-han:overture:g1',
      'ov-a1:overture:a1',
      'ov-a1:overture:a1-dup',
      'ov-a2:overture:a2',
      'ov-a3:overture:a3',
    ]);
    const staging = (await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'poi_stage_%'")).rows[0].n;
    assert.equal(staging, 0, 'staging tables are dropped');

    result = await load();
    assert.notEqual(result.code, 0, 'reloading an existing snapshot needs --replace');
    assert.match(result.out, /--replace/);
    result = await load(['--replace']);
    assert.equal(result.code, 0, result.out);
    const replaced = (await client.query('SELECT id FROM poi_snapshots WHERE version = $1', [VERSION])).rows[0].id;
    created.push(replaced);

    // poi:snapshots lists both; poi:activate works both ways, without a restart.
    result = await run('scripts/poi/snapshots.mjs', ['list', '--env', envFile]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /it-golden/);
    assert.match(result.out, new RegExp(VERSION.replaceAll('.', '\\.')));
    let started = Date.now();
    result = await run('scripts/poi/snapshots.mjs', ['activate', VERSION, '--env', envFile]);
    assert.equal(result.code, 0, result.out);
    assert.ok(Date.now() - started < 10000, 'activation under 10 s');
    assert.match(result.out, /poi:activate it-golden/);
    assert.equal((await client.query('SELECT version FROM poi_snapshots WHERE is_active')).rows[0].version, VERSION);
    started = Date.now();
    result = await run('scripts/poi/snapshots.mjs', ['activate', 'it-golden', '--env', envFile]);
    assert.equal(result.code, 0, result.out);
    assert.ok(Date.now() - started < 10000, 'rollback under 10 s');
    assert.equal((await client.query('SELECT version FROM poi_snapshots WHERE is_active')).rows[0].version, 'it-golden');

    // A snapshot still loading (or unknown) is never activated; the active one is unchanged.
    await client.query(`UPDATE poi_snapshots SET manifest = jsonb_set(manifest, '{status}', '"loading"') WHERE version = $1`, [VERSION]);
    result = await run('scripts/poi/snapshots.mjs', ['activate', VERSION, '--env', envFile]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /chưa nạp xong/);
    result = await run('scripts/poi/snapshots.mjs', ['activate', 'does-not-exist', '--env', envFile]);
    assert.notEqual(result.code, 0);
    assert.equal((await client.query('SELECT version FROM poi_snapshots WHERE is_active')).rows[0].version, 'it-golden');
  } finally {
    await client.query('UPDATE poi_snapshots SET is_active = false WHERE is_active');
    await client.query('DELETE FROM poi_snapshots WHERE id = ANY($1::uuid[]) OR version = $2', [created, VERSION]);
    if (previous) await client.query('UPDATE poi_snapshots SET is_active = true WHERE id = $1', [previous]);
    await rm(dir, { recursive: true, force: true });
  }
}
