// Shared OpenStreetMap clients for the POI scripts (Nominatim + Overpass).
// Policies: Nominatim <= 1 request/second, Overpass >= 3 s between calls, identifying
// User-Agent, every response cached on disk so reruns do not hit the public servers.
import { Resolver } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
export const DANANG_VIEWBOX = '107.2,16.4,108.8,14.9';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Cache key for a Nominatim search (unchanged since the first fetch so old caches stay valid). */
export function nominatimUrl(query) {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'vn');
  url.searchParams.set('viewbox', DANANG_VIEWBOX);
  url.searchParams.set('bounded', '1');
  url.searchParams.set('limit', '3');
  url.searchParams.set('accept-language', 'vi');
  return url;
}

export function dnsServersFrom(args, env = process.env) {
  return (args.includes('--dns') ? args[args.indexOf('--dns') + 1] : (env.POI_DNS_SERVERS ?? ''))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** HTTPS JSON request; with dnsServers the host is resolved through those resolvers. */
export function httpJson(
  url,
  { method = 'GET', headers = {}, body, dnsServers = [], timeoutMs = 15000 },
) {
  if (!dnsServers.length)
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) }).then(
      async (r) => {
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        return r.json();
      },
    );
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
    const req = request(url, { method, headers, lookup, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200)
          return fail(
            Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }),
          );
        try {
          done(JSON.parse(text));
        } catch (error) {
          fail(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { status: 0 })));
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
/** Overpass cache key ignores the server-side [timeout:N] setting. */
const overpassKey = (query) =>
  createHash('sha256')
    .update(query.replace(/\[timeout:\d+\]/, ''))
    .digest('hex');

export async function createOsmClient({ email, dnsServers = [], cacheDir }) {
  if (!email) throw new Error('NOMINATIM_EMAIL chưa được đặt trong .env.');
  const userAgent = `Wolfari-PBL6/0.1 (${email})`;
  const nominatimPath = resolve(cacheDir, '.nominatim-cache.json');
  const overpassPath = resolve(cacheDir, '.overpass-cache.json');
  const load = async (path) => (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {});
  const nominatimCache = await load(nominatimPath);
  const overpassCache = Object.fromEntries(
    Object.values(await load(overpassPath)).map((entry) => [overpassKey(entry.query), entry]),
  );
  let lastNominatim = 0;
  let lastOverpass = 0;

  /** Cached Nominatim search; `cacheOnly` returns undefined instead of calling the server. */
  async function nominatim(query, { cacheOnly = false } = {}) {
    const url = nominatimUrl(query);
    if (Object.hasOwn(nominatimCache, url.search)) return nominatimCache[url.search];
    if (cacheOnly) return undefined;
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await pause(wait);
    lastNominatim = Date.now();
    const payload = await httpJson(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      dnsServers,
    });
    if (!Array.isArray(payload))
      throw new Error(`Nominatim trả dữ liệu không hợp lệ cho "${query}"`);
    const results = payload.map((r) => ({
      lat: r.lat,
      lon: r.lon,
      osm_type: r.osm_type,
      osm_id: r.osm_id,
      display_name: r.display_name,
      category: r.category,
      type: r.type,
    }));
    nominatimCache[url.search] = results;
    await writeFile(nominatimPath, `${JSON.stringify(nominatimCache, null, 2)}\n`);
    return results;
  }

  /** Cached Overpass QL query with endpoint fallback and backoff on 429/5xx/timeouts. */
  async function overpass(query) {
    const key = overpassKey(query);
    if (Object.hasOwn(overpassCache, key)) return overpassCache[key].elements;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
      const wait = lastOverpass + 3000 * (attempt + 1) - Date.now(); // >= 3 s between calls
      if (wait > 0) await pause(wait);
      lastOverpass = Date.now();
      try {
        const payload = await httpJson(endpoint, {
          method: 'POST',
          headers: {
            'User-Agent': userAgent,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ data: query }).toString(),
          dnsServers,
          timeoutMs: 90000,
        });
        if (!Array.isArray(payload.elements)) throw new Error('Overpass trả dữ liệu không hợp lệ');
        overpassCache[key] = { query, elements: payload.elements };
        await writeFile(overpassPath, `${JSON.stringify(overpassCache, null, 2)}\n`);
        return payload.elements;
      } catch (error) {
        lastError = error;
        if (error.status && ![429, 502, 503, 504].includes(error.status)) break;
      }
    }
    throw new Error(`Overpass không phản hồi: ${lastError?.message ?? 'unknown'}`);
  }

  return { nominatim, overpass, userAgent };
}
