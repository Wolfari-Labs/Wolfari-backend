#!/usr/bin/env node
// Fill missing lat/lon in data/poi/danang_golden.csv from OpenStreetMap Nominatim.
// Usage: node --env-file=.env scripts/poi/fetch-coordinates.mjs [--csv <path>] [--dns 1.1.1.1,8.8.8.8]
// --dns (or POI_DNS_SERVERS) resolves the Nominatim host through the given public resolvers,
// for networks whose default DNS does not resolve nominatim.openstreetmap.org.
// Policy: max 1 request/second, identifying User-Agent, results cached on disk.
// Coordinates are never guessed: rows without a match stay empty and are listed.
import { Resolver } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, serializeCsv } from './csv.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const csvPath = resolve(
  root,
  args.includes('--csv') ? args[args.indexOf('--csv') + 1] : 'data/poi/danang_golden.csv',
);
const cachePath = resolve(dirname(csvPath), '.nominatim-cache.json');
const reviewPath = csvPath.replace(/\.csv$/, '.review.md');
const dnsServers = (
  args.includes('--dns') ? args[args.indexOf('--dns') + 1] : (process.env.POI_DNS_SERVERS ?? '')
)
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const VIEWBOX = '107.2,16.4,108.8,14.9';

const email = process.env.NOMINATIM_EMAIL?.trim();
if (!email) {
  console.error(
    'NOMINATIM_EMAIL chưa được đặt. Điền email liên hệ vào .env rồi chạy: node --env-file=.env scripts/poi/fetch-coordinates.mjs',
  );
  process.exit(2);
}
const userAgent = `Wolfari-PBL6/0.1 (${email})`;

const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
let lastRequestAt = 0;

async function search(q) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'vn');
  url.searchParams.set('viewbox', VIEWBOX);
  url.searchParams.set('bounded', '1');
  url.searchParams.set('limit', '3');
  url.searchParams.set('accept-language', 'vi');
  const key = url.search;
  if (Object.hasOwn(cache, key)) return cache[key];
  const wait = lastRequestAt + 1100 - Date.now();
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  lastRequestAt = Date.now();
  const payload = await getJson(url);
  if (!Array.isArray(payload)) throw new Error(`Nominatim trả dữ liệu không hợp lệ cho "${q}"`);
  const results = payload.map((r) => ({
    lat: r.lat,
    lon: r.lon,
    osm_type: r.osm_type,
    osm_id: r.osm_id,
    display_name: r.display_name,
    category: r.category,
    type: r.type,
  }));
  cache[key] = results;
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  return results;
}

async function getJson(url) {
  const headers = { 'User-Agent': userAgent, Accept: 'application/json' };
  if (!dnsServers.length) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    return response.json();
  }
  const resolver = new Resolver();
  resolver.setServers(dnsServers);
  const lookup = (hostname, options, callback) => {
    resolver.resolve4(hostname).then(
      (addresses) =>
        options?.all
          ? callback(
              null,
              addresses.map((address) => ({ address, family: 4 })),
            )
          : callback(null, addresses[0], 4),
      (error) => callback(error),
    );
  };
  return new Promise((done, fail) => {
    const req = request(url, { headers, lookup, timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return fail(new Error(`Nominatim HTTP ${res.statusCode}`));
        try {
          done(JSON.parse(body));
        } catch (error) {
          fail(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Nominatim timeout')));
    req.on('error', fail);
    req.end();
  });
}

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

// Query chain: name_vi → name_en → aliases (CSV order). cacheOnly never touches the network.
async function lookup(row, { cacheOnly = false } = {}) {
  const queries = [row.name_vi, row.name_en, ...(row.aliases ?? '').split('|')]
    .map((x) => x?.trim())
    .filter(Boolean);
  for (const query of queries) {
    const results = cacheOnly ? cached(query) : await search(query);
    if (results === undefined) return undefined;
    if (results.length) return { usedQuery: query, results };
  }
  return null;
}
function cached(query) {
  const url = new URL(ENDPOINT);
  for (const [k, v] of Object.entries({
    q: query,
    format: 'jsonv2',
    countrycodes: 'vn',
    viewbox: VIEWBOX,
    bounded: '1',
    limit: '3',
    'accept-language': 'vi',
  }))
    url.searchParams.set(k, v);
  return cache[url.search];
}

const found = [];
const missing = [];
const matches = new Map();
for (const row of records) {
  if (row.lat && row.lon) {
    // Keep existing coordinates; only recover match details from cache for the review file.
    if (row.coord_source === 'nominatim') {
      const match = await lookup(row, { cacheOnly: true });
      if (match && `${match.results[0].osm_type}/${match.results[0].osm_id}` === row.osm_ref)
        matches.set(row.wolfari_key, match);
    }
    continue;
  }
  const match = await lookup(row);
  if (!match) {
    missing.push(row.wolfari_key);
    console.log(
      `MISS ${row.wolfari_key} — "${row.name_vi}"${row.name_en ? ` / "${row.name_en}"` : ''}`,
    );
    continue;
  }
  const best = match.results[0];
  row.lat = fixed6(best.lat);
  row.lon = fixed6(best.lon);
  row.coord_source = 'nominatim';
  row.coord_verified = 'false';
  row.osm_ref = `${best.osm_type}/${best.osm_id}`;
  matches.set(row.wolfari_key, match);
  found.push(row.wolfari_key);
  console.log(
    `OK   ${row.wolfari_key} → ${row.lat},${row.lon} ${row.osm_ref} (${best.display_name.slice(0, 80)})`,
  );
}
await writeFile(csvPath, serializeCsv(header, records));

const osmLink = (lat, lon) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
const lines = [
  '# Kiểm tọa độ golden list Đà Nẵng',
  '',
  `Sinh bởi \`scripts/poi/fetch-coordinates.mjs\` lúc ${new Date().toISOString()}. Nguồn: © OpenStreetMap contributors (Nominatim, ODbL).`,
  '',
  'Cách kiểm: mở link, đối chiếu ghim với vị trí thật (lối vào/cổng chính với điểm là cả một khu). Sai thì sửa `lat`/`lon` trong CSV (6 chữ số thập phân), đổi `coord_source=manual`. Đúng thì đặt `coord_verified=true`, điền `verified_by`, `verified_at` (YYYY-MM-DD), rồi tick ô dưới đây.',
  '',
  `Tổng: ${records.length} điểm · có tọa độ: ${records.filter((r) => r.lat && r.lon).length} · chưa có: ${records.filter((r) => !(r.lat && r.lon)).length} · đã xác minh: ${records.filter((r) => r.coord_verified === 'true').length}`,
  '',
];
for (const row of records) {
  const checked = row.coord_verified === 'true' ? 'x' : ' ';
  if (!(row.lat && row.lon)) {
    lines.push(
      `- [${checked}] **${row.wolfari_key}** — ${row.name_vi} — ⚠ KHÔNG TÌM THẤY trên Nominatim, cần nhập tay`,
    );
    continue;
  }
  const alt = matches.get(row.wolfari_key);
  const matched = alt
    ? ` · OSM: "${alt.results[0].display_name}" (${alt.results[0].category}/${alt.results[0].type})`
    : '';
  const viaAlias =
    alt && alt.usedQuery !== row.name_vi ? ` · ⚠ khớp theo truy vấn "${alt.usedQuery}"` : '';
  const note = `${matched}${viaAlias}${row.notes ? ` · ghi chú: ${row.notes}` : ''}`;
  lines.push(
    `- [${checked}] **${row.wolfari_key}** — ${row.name_vi} (${row.category}) — ${row.lat}, ${row.lon} · ${row.coord_source || '?'} ${row.osm_ref} — [Bản đồ](${osmLink(row.lat, row.lon)})${note}`,
  );
  if (alt && alt.results.length > 1)
    for (const other of alt.results.slice(1))
      lines.push(
        `  - phương án khác: ${fixed6(other.lat)}, ${fixed6(other.lon)} · ${other.osm_type}/${other.osm_id} · ${other.display_name} — [OSM](${osmLink(fixed6(other.lat), fixed6(other.lon))})`,
      );
}
lines.push('');
await writeFile(reviewPath, lines.join('\n'));

console.log(
  `\nĐã ghi tọa độ: ${found.length} · không tìm thấy: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`,
);
console.log(`CSV: ${csvPath}\nReview: ${reviewPath}`);
