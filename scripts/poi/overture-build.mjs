#!/usr/bin/env node
// POI-OVERTURE O2–O4 (file stage): raw Overture parquet → Wolfari POI parquet, no database.
// Usage: node scripts/poi/overture-build.mjs --release <R> --golden <golden.json>
//          [--raw <parquet>] [--provinces <dir>] [--out <dir>] [--coast-m 300] [--memory 2GB]
//
// Steps (counts of each go to the build manifest and the filter report):
//   1. province by polygon (34 units; Hoàng Sa ⊂ 48, Trường Sa ⊂ 56); points outside every
//      polygon but within --coast-m of one are kept on the coast side unless their Overture
//      address names another country; everything else outside is dropped (other countries).
//   2. record filter: closed, unusable name.            3. category filter + mapping (O2 rules).
//   4. golden match (≤150 m and similar name/alias) → becomes a source of the golden POI.
//   5. Overture duplicates (≤30 m, same group, trigram ≥ 0.85) → keep higher confidence.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import { EXCLUDE, KEEP, MAP, RECORD_REASONS, activityTypeFor, classifyCategory } from './overture-taxonomy.mjs';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { poiCategoryGroup, VN_PROVINCES } = require('../../packages/common/dist/index.js');

export const GOLDEN_RADIUS_M = 150;
export const GOLDEN_MIN_SIMILARITY = 0.6;
export const DUPLICATE_RADIUS_M = 30;
export const DUPLICATE_MIN_SIMILARITY = 0.85;

const { values: args } = parseArgs({
  options: {
    release: { type: 'string' },
    golden: { type: 'string' },
    raw: { type: 'string' },
    provinces: { type: 'string', default: resolve(root, '.local/poi/provinces/src') },
    out: { type: 'string' },
    'coast-m': { type: 'string', default: '300' },
    memory: { type: 'string', default: '2GB' },
    threads: { type: 'string', default: '6' },
  },
});
const release = args.release;
if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release ?? '')) throw new Error('Cần --release <YYYY-MM-DD.n>');
if (!args.golden) throw new Error('Cần --golden <file JSON> (xuất bằng poi:overture).');
const rawPath = resolve(args.raw ?? resolve(root, `.local/poi/overture/raw-vn-bbox-${release}.parquet`));
const outDir = resolve(args.out ?? resolve(root, `.local/poi/overture/build-${release}`));
const tmpDir = resolve(root, '.local/poi/tmp');
const coastM = Number(args['coast-m']);
const threads = Number(args.threads);
if (!Number.isFinite(coastM) || coastM < 0 || coastM > 2000) throw new Error('--coast-m 0..2000');
if (!/^\d+(\.\d+)?\s*[KMGT]i?B$/i.test(args.memory) || !Number.isInteger(threads) || threads < 1)
  throw new Error('Bad --memory or --threads');

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlPath = (path) => sqlString(path.replaceAll('\\', '/'));
const started = performance.now();
const seconds = (from) => Number(((performance.now() - from) / 1000).toFixed(1));
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

await mkdir(outDir, { recursive: true });
await mkdir(tmpDir, { recursive: true });
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
for (const statement of [
  'INSTALL spatial',
  'LOAD spatial',
  `SET memory_limit=${sqlString(args.memory)}`,
  `SET threads=${threads}`,
  `SET temp_directory=${sqlPath(tmpDir)}`,
  'SET preserve_insertion_order=false',
])
  await db.run(statement);
const rows = async (sql) => (await db.runAndReadAll(sql)).getRowObjects();
const scalar = async (sql) => Object.values((await rows(sql))[0])[0];
const count = async (table) => Number(await scalar(`SELECT count(*) FROM ${table}`));
const step = (label, from) => console.log(`  ${label} (${seconds(from)} s)`);
const counts = {};

// Text helpers. fold() mirrors foldText() in overture-taxonomy.mjs for Latin script; trgm()
// mirrors pg_trgm (each word padded '  w ', distinct trigrams); sim = |A∩B| / |A∪B|.
await db.run(`CREATE MACRO fold(s) AS trim(regexp_replace(
  lower(strip_accents(replace(replace(coalesce(s, ''), 'đ', 'd'), 'Đ', 'D'))), '[^a-z0-9]+', ' ', 'g'))`);
await db.run(`CREATE MACRO trgm(s) AS list_distinct(flatten(list_transform(
  list_filter(string_split(s, ' '), w -> w <> ''),
  w -> list_transform(range(1, length(w) + 2), i -> substr('  ' || w || ' ', i, 3)))))`);
await db.run(`CREATE MACRO trgm_sim(a, b) AS CASE WHEN len(a) = 0 OR len(b) = 0 THEN 0.0
  ELSE len(list_intersect(a, b)) / (len(a) + len(b) - len(list_intersect(a, b)))::DOUBLE END`);
await db.run(`CREATE MACRO meters(lat1, lon1, lat2, lon2) AS 2 * 6371000 * asin(sqrt(
  power(sin(radians(lat2 - lat1) / 2), 2) +
  cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)))`);

// ---- 0. raw ------------------------------------------------------------------------------
let t = performance.now();
await db.run(`CREATE TABLE raw AS SELECT
    id, confidence, names, addresses, sources, operating_status, basic_category, taxonomy,
    bbox.ymin AS lat, bbox.xmin AS lon, array_to_string(taxonomy.hierarchy, '>') AS path
  FROM read_parquet(${sqlPath(rawPath)})`);
counts.raw = await count('raw');
step(`thô ${counts.raw}`, t);

// ---- 1. provinces ------------------------------------------------------------------------
t = performance.now();
await db.run('CREATE TABLE prov(code VARCHAR, geom GEOMETRY)');
const provinceFiles = (await readdir(args.provinces)).filter((f) => f.endsWith('.geojson')).sort();
const provinceInputs = [];
for (const file of provinceFiles) {
  const path = resolve(args.provinces, file);
  const feature = JSON.parse(await readFile(path, 'utf8')).features[0];
  const code = feature.properties.code;
  if (!Object.hasOwn(VN_PROVINCES, code)) throw new Error(`Mã tỉnh lạ trong ${file}: ${code}`);
  const insert = await db.prepare('INSERT INTO prov VALUES ($1, ST_GeomFromGeoJSON($2))');
  insert.bindVarchar(1, code);
  insert.bindVarchar(2, JSON.stringify(feature.geometry));
  await insert.run();
  provinceInputs.push({ file, sha256: await sha256(path) });
}
if (provinceInputs.length !== 34) throw new Error(`Cần 34 polygon tỉnh, có ${provinceInputs.length}`);
await db.run(`CREATE TABLE pt AS SELECT id, ST_Point(lon, lat) AS g FROM raw`);
await db.run(`CREATE TABLE inside AS SELECT pt.id, min(prov.code) AS code
  FROM pt JOIN prov ON ST_Intersects(prov.geom, pt.g) GROUP BY pt.id`);
counts.inside_polygon = await count('inside');
// Coast buffer in degrees (≈ metres / 111 km); only for points no polygon contains.
const coastDeg = coastM / 111_000;
await db.run(`CREATE TABLE coast AS
  WITH o AS (SELECT pt.* FROM pt ANTI JOIN inside USING (id)),
  near AS (
    SELECT o.id, prov.code, ST_Distance(prov.geom, o.g) AS d
    FROM o JOIN (SELECT code, geom, ST_Buffer(geom, ${coastDeg}) AS zone FROM prov) prov
      ON ${coastM > 0 ? 'ST_Intersects(prov.zone, o.g)' : 'false'})
  SELECT near.id, arg_min(near.code, near.d) AS code
  FROM near JOIN raw USING (id)
  WHERE coalesce(raw.addresses[1].country, 'VN') = 'VN'
  GROUP BY near.id`);
counts.coast_buffer = await count('coast');
await db.run(`CREATE TABLE located AS
  SELECT raw.*, p.code AS province_code, p.how
  FROM raw JOIN (SELECT id, code, 'polygon' AS how FROM inside
                 UNION ALL SELECT id, code, 'coast' AS how FROM coast) p USING (id)`);
counts.after_polygon = await count('located');
step(`trong polygon ${counts.inside_polygon} + ven biển ${counts.coast_buffer}`, t);

// ---- 2+3. record filter, categories ----------------------------------------------------------
t = performance.now();
// Records without taxonomy but with basic_category take the most common path of that basic category.
await db.run(`CREATE TABLE basic_path AS SELECT basic_category, mode(path) AS path
  FROM located WHERE path IS NOT NULL AND basic_category IS NOT NULL GROUP BY 1`);
await db.run(`UPDATE located SET path = b.path FROM basic_path b
  WHERE located.path IS NULL AND located.basic_category = b.basic_category`);
const paths = (await rows('SELECT DISTINCT path FROM located')).map((r) => r.path);
await db.run(
  'CREATE TABLE cat(path VARCHAR, action VARCHAR, reason VARCHAR, code VARCHAR, grp VARCHAR, activity VARCHAR)',
);
const appender = await db.createAppender('cat');
for (const path of paths) {
  const c = classifyCategory(path);
  const code = c.action === 'keep' ? c.code : null;
  const group = code ? poiCategoryGroup(code) : null;
  if (code && !group) throw new Error(`Mã ${code} không thuộc nhóm tìm kiếm nào`);
  for (const value of [path, c.action, c.reason ?? null, code, group, code ? activityTypeFor(code) : null]) {
    if (value === null) appender.appendNull();
    else appender.appendVarchar(value);
  }
  appender.endRow();
}
appender.closeSync();
// The first matching reason wins, in this order: closed → bad_name → category.
await db.run(`CREATE TABLE judged AS
  SELECT l.*, c.code, c.grp, c.activity,
    fold(l.names."primary") AS fname,
    fold(l.addresses[1].freeform) AS faddr,
    CASE
      WHEN l.operating_status IN ('permanently_closed', 'temporarily_closed') THEN 'closed'
      WHEN NOT regexp_matches(coalesce(l.names."primary", ''), '\\pL')
        OR (fold(l.names."primary") <> '' AND fold(l.names."primary") = fold(l.addresses[1].freeform))
        OR regexp_matches(fold(l.names."primary"), '^(so nha|so|hem|kiet|ngo|ngach|lo|to) [0-9]')
        OR (regexp_matches(fold(l.names."primary"), '^[0-9]+[a-z]?( [0-9]+[a-z]?)* ')
            AND starts_with(fold(l.addresses[1].freeform), fold(l.names."primary")))
        THEN 'bad_name'
      WHEN c.action = 'exclude' THEN c.reason
    END AS dropped
  FROM located l JOIN cat c ON c.path IS NOT DISTINCT FROM l.path`);
await db.run('CREATE TABLE kept AS SELECT * FROM judged WHERE dropped IS NULL');
counts.after_filter = await count('kept');
step(`sau loại bỏ ${counts.after_filter}`, t);

// ---- 4. golden match ---------------------------------------------------------------------
t = performance.now();
const golden = JSON.parse(await readFile(args.golden, 'utf8'));
if (!Array.isArray(golden) || !golden.length) throw new Error('File golden rỗng');
// A golden POI only absorbs Overture records of its own search group (beach ≠ beach hotel).
const goldenGroups = golden.map((g) => [g.wolfari_key, poiCategoryGroup(g.category ?? '')]);
const ungrouped = goldenGroups.filter(([, group]) => !group).map(([key]) => key);
if (ungrouped.length) throw new Error(`Golden thiếu category/nhóm: ${ungrouped.join(', ')}`);
await db.run(`CREATE TABLE golden AS SELECT * FROM read_json(${sqlPath(resolve(args.golden))},
  columns = {wolfari_key: 'VARCHAR', name_vi: 'VARCHAR', name_en: 'VARCHAR', aliases: 'VARCHAR[]',
             category: 'VARCHAR', latitude: 'DOUBLE', longitude: 'DOUBLE'})`);
await db.run('CREATE TABLE golden_group(wolfari_key VARCHAR, grp VARCHAR)');
const groupAppender = await db.createAppender('golden_group');
for (const [key, group] of goldenGroups) {
  groupAppender.appendVarchar(key);
  groupAppender.appendVarchar(group);
  groupAppender.endRow();
}
groupAppender.closeSync();
// Golden pins are reviewed by hand: a pin just off the polygon edge (shoreline) takes the
// nearest province instead of none.
await db.run(`CREATE TABLE golden_province AS
  SELECT g.wolfari_key,
    coalesce(min(prov.code) FILTER (WHERE ST_Intersects(prov.geom, ST_Point(g.longitude, g.latitude))),
             arg_min(prov.code, ST_Distance(prov.geom, ST_Point(g.longitude, g.latitude)))) AS province_code,
    bool_or(ST_Intersects(prov.geom, ST_Point(g.longitude, g.latitude))) AS inside
  FROM golden g, prov GROUP BY 1`);
// Release 2026-10-21.0 leaves names.common empty; alternate names live in names.rules[].value.
const ruleNames = (alias) => `list_transform(coalesce(${alias}.names.rules, []), r -> r.value)`;
const names = (alias) => `list_filter(list_distinct([fold(${alias}.names."primary")] ||
  list_transform(${ruleNames(alias)}, v -> fold(v))), v -> v <> '')`;
const dLat = GOLDEN_RADIUS_M / 111_000;
await db.run(`CREATE TABLE golden_match AS
  WITH g AS (
    SELECT golden.wolfari_key, latitude, longitude, gg.grp,
      list_filter(list_distinct([fold(name_vi), fold(name_en)] ||
        list_transform(coalesce(aliases, []), a -> fold(a))), v -> v <> '') AS gnames
    FROM golden JOIN golden_group gg USING (wolfari_key)),
  pairs AS (
    SELECT g.wolfari_key, k.id, meters(g.latitude, g.longitude, k.lat, k.lon) AS distance_m,
      ${names('k')} AS onames, g.gnames
    FROM g JOIN kept k
      ON k.grp = g.grp
     AND k.lat BETWEEN g.latitude - ${dLat} AND g.latitude + ${dLat}
     AND k.lon BETWEEN g.longitude - ${dLat * 1.2} AND g.longitude + ${dLat * 1.2}),
  scored AS (
    SELECT *, list_max(flatten(list_transform(onames, o -> list_transform(gnames,
        n -> trgm_sim(trgm(o), trgm(n)))))) AS sim,
      len(list_intersect(onames, gnames)) > 0 AS alias_hit
    FROM pairs WHERE distance_m <= ${GOLDEN_RADIUS_M})
  SELECT wolfari_key, id, distance_m, sim, alias_hit FROM scored
  WHERE alias_hit OR sim >= ${GOLDEN_MIN_SIMILARITY}
  QUALIFY row_number() OVER (PARTITION BY id ORDER BY alias_hit DESC, sim DESC, distance_m) = 1`);
counts.golden_matched = await count('golden_match');
await db.run('CREATE TABLE candidates AS SELECT * FROM kept ANTI JOIN golden_match USING (id)');
step(`ghép golden ${counts.golden_matched}`, t);

// ---- 5. Overture duplicates --------------------------------------------------------------
t = performance.now();
const cell = DUPLICATE_RADIUS_M / 111_000;
await db.run(`CREATE TABLE cells AS SELECT id, grp, lat, lon, coalesce(confidence, 0) AS confidence,
    floor(lat / ${cell})::BIGINT AS cy, floor(lon / ${cell})::BIGINT AS cx, fname
  FROM candidates`);
await db.run(`CREATE TABLE dup_pairs AS
  WITH near AS (
    SELECT a.id AS a, b.id AS b, a.confidence AS ca, b.confidence AS cb, a.fname AS fa, b.fname AS fb
    FROM cells a
    JOIN (SELECT c.*, d.dx, e.dy FROM cells c, (VALUES (-1), (0), (1)) d(dx), (VALUES (-1), (0), (1)) e(dy)) b
      ON a.cx = b.cx + b.dx AND a.cy = b.cy + b.dy AND a.grp = b.grp AND a.id < b.id
    WHERE meters(a.lat, a.lon, b.lat, b.lon) <= ${DUPLICATE_RADIUS_M})
  SELECT a, b, ca, cb FROM near
  WHERE fa = fb OR trgm_sim(trgm(fa), trgm(fb)) >= ${DUPLICATE_MIN_SIMILARITY}`);
counts.duplicate_pairs = await count('dup_pairs');
// Loser → best winner (higher confidence, then smaller id); then follow chains to a survivor.
await db.run(`CREATE TABLE merged AS
  WITH edges AS (
    SELECT CASE WHEN ca > cb OR (ca = cb AND a < b) THEN b ELSE a END AS loser,
           CASE WHEN ca > cb OR (ca = cb AND a < b) THEN a ELSE b END AS winner,
           greatest(ca, cb) AS wc
    FROM dup_pairs)
  SELECT loser AS id, arg_min(winner, (-wc, winner)) AS target FROM edges GROUP BY loser`);
for (let i = 0; i < 50; i++) {
  const chained = Number(
    await scalar('SELECT count(*) FROM merged m JOIN merged n ON m.target = n.id'),
  );
  if (!chained) break;
  if (i === 49) throw new Error('Chuỗi trùng không hội tụ');
  await db.run(`UPDATE merged SET target = n.target FROM merged n WHERE merged.target = n.id`);
}
counts.duplicates_merged = await count('merged');
step(`trùng nội bộ: ${counts.duplicate_pairs} cặp, gộp ${counts.duplicates_merged}`, t);

// ---- output ------------------------------------------------------------------------------
t = performance.now();
const fetchedAt = JSON.parse(
  await readFile(rawPath.replace(/\.parquet$/, '.manifest.json'), 'utf8').catch(() => '{}'),
).createdAt ?? new Date().toISOString();
await db.run(`CREATE TABLE src AS
  SELECT coalesce(m.target, c.id) AS owner, c.id AS gers_id,
    list_sort(list_distinct(list_filter(list_transform(c.sources, x -> x.license), x -> x IS NOT NULL))) AS licenses,
    list_filter(list_distinct(list_transform(c.sources, x -> CASE WHEN x.dataset IN ('Overture', 'Overture-signals') THEN NULL
      ELSE x.dataset || ' (' || x.license || ')' END)), x -> x IS NOT NULL) AS credits
  FROM candidates c LEFT JOIN merged m USING (id)`);
await db.run(`CREATE TABLE out AS
  WITH agg AS (
    SELECT owner, list_sort(list_distinct(flatten(list(licenses)))) AS licenses,
      list_sort(list_distinct(flatten(list(credits)))) AS credits,
      list(struct_pack(gers_id := gers_id, license := array_to_string(licenses, '; ')) ORDER BY gers_id) AS sources
    FROM src GROUP BY owner)
  SELECT 'ov-' || c.id AS wolfari_key, c.id AS gers_id,
    trim(c.names."primary") AS name_vi,
    nullif(list_filter(list_transform(list_filter(coalesce(c.names.rules, []), r -> r."language" = 'en'),
      r -> trim(r.value)), v -> v <> '' AND v <> trim(c.names."primary"))[1], '') AS name_en,
    list_filter(list_distinct(list_transform(${ruleNames('c')}, v -> trim(v))),
      v -> v <> '' AND v <> trim(c.names."primary"))[1:5] AS aliases,
    c.code AS category, c.grp AS category_group, c.activity AS activity_type,
    round(c.lat, 6) AS latitude, round(c.lon, 6) AS longitude,
    c.province_code, c.how AS located_by,
    CASE WHEN coalesce(c.addresses[1].country, 'VN') = 'VN' THEN
      nullif(concat_ws(', ', nullif(trim(c.addresses[1].freeform), ''), nullif(trim(c.addresses[1].locality), '')), '') END AS address,
    CASE WHEN coalesce(c.addresses[1].country, 'VN') = 'VN' THEN nullif(trim(c.addresses[1].freeform), '') END AS address_short,
    round(coalesce(c.confidence, 0), 3) AS confidence,
    array_to_string(a.licenses, '; ') AS license,
    array_to_string(['© Overture Maps Foundation'] || a.credits, '; ') AS attribution,
    a.sources, c.path AS overture_category
  FROM candidates c JOIN agg a ON a.owner = c.id`);
counts.new_pois = await count('out');
const tooLong = Number(await scalar('SELECT count(*) FROM out WHERE length(license) > 40 OR length(wolfari_key) > 120'));
if (tooLong) throw new Error(`${tooLong} POI có license/wolfari_key vượt độ dài cột`);
await db.run(`CREATE TABLE golden_src AS
  SELECT g.wolfari_key, g.id AS gers_id, round(g.distance_m, 1) AS distance_m, round(g.sim, 3) AS sim, g.alias_hit,
    array_to_string(list_sort(list_distinct(list_filter(list_transform(k.sources, x -> x.license), x -> x IS NOT NULL))), '; ') AS license,
    trim(k.names."primary") AS overture_name
  FROM golden_match g JOIN kept k USING (id)`);

const write = async (table, name) => {
  const path = resolve(outDir, name);
  await rm(`${path}.partial`, { force: true });
  await db.run(`COPY ${table} TO ${sqlPath(`${path}.partial`)} (FORMAT parquet, COMPRESSION zstd)`);
  await rename(`${path}.partial`, path);
  return path;
};
const poisPath = await write('out', 'pois.parquet');
await write('golden_src', 'golden-sources.parquet');
await write('golden_province', 'golden-provinces.parquet');
step(`POI mới ${counts.new_pois}`, t);

// ---- filter report -----------------------------------------------------------------------
const labels = { ...Object.fromEntries(Object.entries(EXCLUDE).map(([k, [label]]) => [k, label])), ...RECORD_REASONS };
const byReason = (await rows(`SELECT dropped AS reason, count(*) AS n FROM judged WHERE dropped IS NOT NULL GROUP BY 1 ORDER BY n DESC`))
  .map((r) => ({ reason: r.reason, label: labels[r.reason], n: Number(r.n) }));
byReason.unshift({ reason: 'outside_vn', label: labels.outside_vn, n: counts.raw - counts.after_polygon });
const topDropped = (await rows(`SELECT path, dropped AS reason, count(*) AS n FROM judged
    WHERE dropped IS NOT NULL AND dropped NOT IN ('closed', 'bad_name') GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT 50`))
  .map((r) => ({ category: r.path, reason: r.reason, n: Number(r.n) }));
const topOther = (await rows(`SELECT coalesce(path, '(không có category)') AS path, count(*) AS n FROM kept
    WHERE code = 'other' GROUP BY 1 ORDER BY n DESC, 1 LIMIT 50`))
  .map((r) => ({ category: r.path, n: Number(r.n) }));
const byCode = (await rows(`SELECT category, category_group, count(*) AS n FROM out GROUP BY 1, 2 ORDER BY n DESC`))
  .map((r) => ({ code: r.category, group: r.category_group, n: Number(r.n) }));
const coastByProvince = (await rows(`SELECT province_code, count(*) AS n FROM out WHERE located_by = 'coast' GROUP BY 1 ORDER BY n DESC`))
  .map((r) => ({ province_code: r.province_code, n: Number(r.n) }));
const goldenMatches = (await rows(`SELECT wolfari_key, count(*) AS n FROM golden_src GROUP BY 1 ORDER BY 1`))
  .map((r) => ({ wolfari_key: r.wolfari_key, n: Number(r.n) }));
const goldenOutside = (await rows(`SELECT wolfari_key, province_code FROM golden_province WHERE NOT inside ORDER BY 1`))
  .map((r) => ({ wolfari_key: r.wolfari_key, nearest_province: r.province_code }));
// Borderline golden matches (cross-group or low similarity) are listed for the reviewer.
const goldenWeak = (await rows(`SELECT g.wolfari_key, g.overture_name, g.distance_m, g.sim, k.code AS overture_code
    FROM golden_src g JOIN kept k ON k.id = g.gers_id WHERE NOT g.alias_hit AND g.sim < 0.7 ORDER BY g.sim, 1`))
  .map((r) => ({ ...r, distance_m: Number(r.distance_m), sim: Number(r.sim) }));
instance.closeSync?.();

const manifest = {
  step: 'O2-O4 build',
  release,
  raw: { file: rawPath.slice(root.length + 1).replaceAll('\\', '/'), sha256: await sha256(rawPath) },
  golden: { file: resolve(args.golden).slice(root.length + 1).replaceAll('\\', '/'), sha256: await sha256(args.golden), rows: golden.length },
  provinces: { source: 'thanglequoc/vietnamese-provinces-database (MIT)', files: provinceInputs },
  rules: {
    coast_buffer_m: coastM,
    golden: { radius_m: GOLDEN_RADIUS_M, min_similarity: GOLDEN_MIN_SIMILARITY, same_group: true },
    duplicates: { radius_m: DUPLICATE_RADIUS_M, min_similarity: DUPLICATE_MIN_SIMILARITY },
    taxonomy_sha256: createHash('sha256').update(JSON.stringify({ KEEP, EXCLUDE, MAP })).digest('hex'),
  },
  fetched_at: fetchedAt,
  counts,
  outputs: { pois: { file: 'pois.parquet', sha256: await sha256(poisPath), bytes: (await stat(poisPath)).size }, golden_sources: 'golden-sources.parquet' },
  golden_outside_polygon: goldenOutside,
  seconds: seconds(started),
  created_at: new Date().toISOString(),
};
await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const report = { release, counts, dropped_by_reason: byReason, top_dropped_categories: topDropped, top_other_categories: topOther, pois_by_code: byCode, coast_buffer_by_province: coastByProvince, golden_matches: goldenMatches, golden_weak_matches: goldenWeak, golden_outside_polygon: goldenOutside };
const reportsDir = resolve(root, '.local/poi/reports');
await mkdir(reportsDir, { recursive: true });
await writeFile(resolve(reportsDir, `filter-${release}.json`), `${JSON.stringify(report, null, 2)}\n`);
const table = (head, list) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...list.map((r) => `| ${r.join(' | ')} |`)].join('\n');
await writeFile(
  resolve(reportsDir, `filter-${release}.md`),
  [
    `# Báo cáo lọc Overture ${release}`,
    '',
    `Thô ${counts.raw} → trong polygon ${counts.inside_polygon} + ven biển ${counts.coast_buffer} = ${counts.after_polygon} → sau loại bỏ ${counts.after_filter} → ghép golden ${counts.golden_matched} → gộp trùng ${counts.duplicates_merged} → **POI mới ${counts.new_pois}**`,
    '',
    '## Bị bỏ theo lý do',
    table(['Lý do', 'Mô tả', 'Số'], byReason.map((r) => [r.reason, r.label, r.n])),
    '',
    '## TOP 50 category bị bỏ',
    'Cứu lại: xóa dòng tương ứng trong `EXCLUDE` (hoặc thêm vào `KEEP`) ở `scripts/poi/overture-taxonomy.mjs`, rồi chạy lại từ file thô.',
    '',
    table(['#', 'Category Overture', 'Lý do', 'Số'], topDropped.map((r, i) => [i + 1, `\`${r.category}\``, r.reason, r.n])),
    '',
    '## TOP 50 category vào `other`',
    table(['#', 'Category Overture', 'Số'], topOther.map((r, i) => [i + 1, `\`${r.category}\``, r.n])),
    '',
    '## POI mới theo mã',
    table(['Mã', 'Nhóm', 'Số'], byCode.map((r) => [r.code, r.group, r.n])),
    '',
    `## Ghép golden: ${goldenMatches.length}/${golden.length} điểm golden có nguồn Overture`,
    'Ghép yếu (không khớp alias, similarity < 0.7) — bản ghi Overture này KHÔNG thành POI riêng:',
    '',
    table(['Golden', 'Tên Overture', 'Mã Overture', 'm', 'sim'], goldenWeak.map((r) => [r.wolfari_key, r.overture_name, r.overture_code, r.distance_m, r.sim])),
    '',
    `Golden ngoài polygon (gán tỉnh gần nhất): ${goldenOutside.map((g) => `${g.wolfari_key}→${g.nearest_province}`).join(', ') || 'không có'}`,
    '',
  ].join('\n'),
);
await rm(tmpDir, { recursive: true, force: true });
console.log(`Xong build ${release} trong ${manifest.seconds} s → ${outDir.slice(root.length + 1)}`);
console.log(JSON.stringify(counts));
