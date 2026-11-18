#!/usr/bin/env node
// POI-OVERTURE O1: download Overture Places for Vietnam into one raw GeoParquet file.
// Usage: node scripts/poi/overture-download.mjs [--release <R>] [--config <path>] [--memory 3GB] [--threads 6]
//
// Each box in the config is read with its own bbox-pushdown query into a part file, then the
// parts are merged (deduplicated by GERS id) into .local/poi/overture/raw-vn-bbox-<R>.parquet.
// All columns are kept. No country filter: country/province come from polygons in O3.
// Re-running is safe: finished part files are reused, outputs are written to *.partial and
// renamed only when complete. DuckDB spills to .local/poi/tmp, which is removed at the end.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';

const root = resolve(import.meta.dirname, '../..');
const { values: args } = parseArgs({
  options: {
    release: { type: 'string' },
    config: { type: 'string', default: resolve(import.meta.dirname, 'overture-vn.config.json') },
    memory: { type: 'string' },
    threads: { type: 'string' },
  },
});
const config = JSON.parse(await readFile(args.config, 'utf8'));
const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;

const outDir = resolve(root, '.local/poi/overture');
const tmpDir = resolve(root, '.local/poi/tmp');
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlPath = (path) => sqlString(path.replaceAll('\\', '/'));
const number = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Bad number in config: ${value}`);
  return String(value);
};
const seconds = (start) => ((performance.now() - start) / 1000).toFixed(1);

async function latestRelease() {
  const response = await fetch(config.stacCatalog, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`STAC catalog HTTP ${response.status}`);
  const catalog = await response.json();
  return catalog.latest;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const release = args.release ?? (await latestRelease());
if (!RELEASE_PATTERN.test(release)) throw new Error(`Unexpected release name: ${release}`);
const source = `${config.bucket}/${release}/theme=places/type=place/*.parquet`;
const partsDir = resolve(outDir, `parts-${release}`);
const rawPath = resolve(outDir, `raw-vn-bbox-${release}.parquet`);
const manifestPath = resolve(outDir, `raw-vn-bbox-${release}.manifest.json`);
await mkdir(partsDir, { recursive: true });
await mkdir(tmpDir, { recursive: true });

const memory = args.memory ?? config.duckdb.memoryLimit;
const threads = Number(args.threads ?? config.duckdb.threads);
if (!/^\d+(\.\d+)?\s*[KMGT]i?B$/i.test(memory) || !Number.isInteger(threads) || threads < 1) {
  throw new Error('Bad --memory or --threads');
}

const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
for (const statement of [
  'INSTALL httpfs',
  'LOAD httpfs',
  `SET s3_region=${sqlString(config.region)}`,
  `SET memory_limit=${sqlString(memory)}`,
  `SET threads=${threads}`,
  `SET temp_directory=${sqlPath(tmpDir)}`,
  'SET preserve_insertion_order=false',
  'SET http_retries=10',
  'SET http_retry_wait_ms=2000',
  'SET http_timeout=120000',
]) {
  await db.run(statement);
}
const scalar = async (sql) => Object.values((await db.runAndReadAll(sql)).getRowObjects()[0])[0];

console.log(`Overture ${release} · ${config.boxes.length} box · memory ${memory} · threads ${threads}`);
const started = performance.now();
const boxes = [];
for (const box of config.boxes) {
  if (!/^[a-z0-9-]+$/.test(box.name)) throw new Error(`Bad box name: ${box.name}`);
  const partPath = resolve(partsDir, `${box.name}.parquet`);
  const boxStart = performance.now();
  let reused = false;
  if (existsSync(partPath)) {
    try {
      await scalar(`SELECT count(*) FROM read_parquet(${sqlPath(partPath)})`);
      reused = true;
    } catch {
      await rm(partPath, { force: true });
    }
  }
  if (!reused) {
    const partial = `${partPath}.partial`;
    await rm(partial, { force: true });
    // Point places have xmin = xmax, so containment == intersection; the comparisons on the
    // bbox struct are pushed down to parquet row-group statistics.
    await db.run(`COPY (
      SELECT * FROM read_parquet(${sqlString(source)}, hive_partitioning = false)
      WHERE bbox.xmin >= ${number(box.minLon)} AND bbox.xmax <= ${number(box.maxLon)}
        AND bbox.ymin >= ${number(box.minLat)} AND bbox.ymax <= ${number(box.maxLat)}
    ) TO ${sqlPath(partial)} (FORMAT parquet, COMPRESSION zstd)`);
    await rename(partial, partPath);
  }
  const rows = Number(await scalar(`SELECT count(*) FROM read_parquet(${sqlPath(partPath)})`));
  boxes.push({ ...box, rows, seconds: Number(seconds(boxStart)), reused });
  console.log(`  ${box.name}: ${rows} dòng (${reused ? 'dùng lại part có sẵn' : `${seconds(boxStart)} s`})`);
}

// Merge: keep the first occurrence of each GERS id in config order (boxes are disjoint, so
// duplicates are not expected; the anti-joins make that explicit rather than assumed).
const parts = config.boxes.map((box) => sqlPath(resolve(partsDir, `${box.name}.parquet`)));
const selects = parts.map((part, index) => {
  const earlier = parts.slice(0, index);
  const anti = earlier.length
    ? ` WHERE id NOT IN (SELECT id FROM read_parquet([${earlier.join(', ')}]))`
    : '';
  return `SELECT * FROM read_parquet(${part})${anti}`;
});
const rawPartial = `${rawPath}.partial`;
await rm(rawPartial, { force: true });
const mergeStart = performance.now();
await db.run(
  `COPY (${selects.join(' UNION ALL ')}) TO ${sqlPath(rawPartial)} (FORMAT parquet, COMPRESSION zstd)`,
);
await rename(rawPartial, rawPath);
const raw = `read_parquet(${sqlPath(rawPath)})`;
const rawRows = Number(await scalar(`SELECT count(*) FROM ${raw}`));
const distinctIds = Number(await scalar(`SELECT count(DISTINCT id) FROM ${raw}`));
if (rawRows !== distinctIds) throw new Error(`Merged file has duplicate ids: ${rawRows} vs ${distinctIds}`);
console.log(`Gộp: ${rawRows} dòng (${seconds(mergeStart)} s)`);

const columns = (await db.runAndReadAll(`DESCRIBE SELECT * FROM ${raw}`))
  .getRowObjects()
  .map((row) => ({ name: row.column_name, type: row.column_type }));
const top = async (expression) =>
  (
    await db.runAndReadAll(
      `SELECT ${expression} AS category, count(*) AS n FROM ${raw} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 30`,
    )
  )
    .getRowObjects()
    .map((row) => ({ category: row.category, n: Number(row.n) }));
const topBasic = await top('basic_category');
const topPrimary = await top('taxonomy."primary"');
const status = (
  await db.runAndReadAll(`SELECT operating_status, count(*) AS n FROM ${raw} GROUP BY 1 ORDER BY n DESC`)
)
  .getRowObjects()
  .map((row) => ({ operating_status: row.operating_status, n: Number(row.n) }));
const datasets = (
  await db.runAndReadAll(
    `SELECT s.dataset AS dataset, s.license AS license, count(*) AS n
     FROM (SELECT unnest(sources) AS s FROM ${raw}) GROUP BY 1, 2 ORDER BY n DESC`,
  )
)
  .getRowObjects()
  .map((row) => ({ dataset: row.dataset, license: row.license, n: Number(row.n) }));
const distinct = {
  basic_category: Number(await scalar(`SELECT count(DISTINCT basic_category) FROM ${raw}`)),
  taxonomy_primary: Number(await scalar(`SELECT count(DISTINCT taxonomy."primary") FROM ${raw}`)),
};
instance.closeSync?.();

const bytes = (await stat(rawPath)).size;
const manifest = {
  step: 'O1',
  release,
  source,
  file: rawPath.slice(root.length + 1).replaceAll('\\', '/'),
  bytes,
  sha256: await sha256(rawPath),
  rows: rawRows,
  boxes,
  seconds: Number(seconds(started)),
  createdAt: new Date().toISOString(),
  duckdb: { memory, threads },
  columns,
  distinct,
  topBasicCategory: topBasic,
  topTaxonomyPrimary: topPrimary,
  operatingStatus: status,
  sourceDatasets: datasets,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// The raw file is the durable output; parts and DuckDB spill files are not needed anymore.
await rm(partsDir, { recursive: true, force: true });
await rm(tmpDir, { recursive: true, force: true });
console.log(`Xong O1: ${manifest.file} · ${(bytes / 1024 ** 2).toFixed(1)} MiB · ${manifest.seconds} s`);
console.log(`Manifest: ${manifestPath.slice(root.length + 1)}`);
