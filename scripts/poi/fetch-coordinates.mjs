#!/usr/bin/env node
// Fill missing lat/lon in data/poi/danang_golden.csv from OpenStreetMap Nominatim.
// Usage: node --env-file=.env scripts/poi/fetch-coordinates.mjs [--csv <path>] [--dns 1.1.1.1,8.8.8.8]
// --dns (or POI_DNS_SERVERS) resolves OSM hosts through the given public resolvers, for networks
// whose default DNS does not resolve nominatim.openstreetmap.org.
// Policy: max 1 request/second, identifying User-Agent, results cached on disk.
// Coordinates are never guessed: rows without a match stay empty and are listed.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, serializeCsv } from './csv.mjs';
import { createOsmClient, dnsServersFrom } from './osm.mjs';
import { writeReview } from './review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const csvPath = resolve(
  root,
  args.includes('--csv') ? args[args.indexOf('--csv') + 1] : 'data/poi/danang_golden.csv',
);
const email = process.env.NOMINATIM_EMAIL?.trim();
if (!email) {
  console.error(
    'NOMINATIM_EMAIL chưa được đặt. Điền email liên hệ vào .env rồi chạy: corepack pnpm poi:fetch',
  );
  process.exit(2);
}
const osm = await createOsmClient({
  email,
  dnsServers: dnsServersFrom(args),
  cacheDir: dirname(csvPath),
});

const fixed6 = (value) => Number(value).toFixed(6);
const { header, records } = parseCsv(await readFile(csvPath, 'utf8'));
const required = [
  'wolfari_key',
  'name_vi',
  'name_en',
  'lat',
  'lon',
  'coord_source',
  'coord_verified',
  'osm_ref',
];
for (const column of required)
  if (!header.includes(column)) throw new Error(`CSV thiếu cột ${column}`);

const found = [];
const missing = [];
for (const row of records) {
  if (row.lat && row.lon) continue;
  // name_vi → name_en → aliases (CSV order); the review shows which query matched.
  const queries = [row.name_vi, row.name_en, ...(row.aliases ?? '').split('|')]
    .map((x) => x?.trim())
    .filter(Boolean);
  let best;
  for (const query of queries) {
    const results = await osm.nominatim(query);
    if (results.length) {
      best = results[0];
      break;
    }
  }
  if (!best) {
    missing.push(row.wolfari_key);
    console.log(
      `MISS ${row.wolfari_key} — "${row.name_vi}"${row.name_en ? ` / "${row.name_en}"` : ''}`,
    );
    continue;
  }
  row.lat = fixed6(best.lat);
  row.lon = fixed6(best.lon);
  row.coord_source = 'nominatim';
  row.coord_verified = 'false';
  row.osm_ref = `${best.osm_type}/${best.osm_id}`;
  found.push(row.wolfari_key);
  console.log(
    `OK   ${row.wolfari_key} → ${row.lat},${row.lon} ${row.osm_ref} (${best.display_name.slice(0, 80)})`,
  );
}
await writeFile(csvPath, serializeCsv(header, records));
const review = await writeReview(csvPath);
console.log(
  `\nĐã ghi tọa độ: ${found.length} · không tìm thấy: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`,
);
console.log(`CSV: ${csvPath}\nReview: ${review.review}`);
