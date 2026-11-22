// POI-IMAGES: polite HTTP for Wikimedia/OSM — ≤ 3 requests in flight, retry with backoff,
// Retry-After honoured, and an on-disk cache so a re-run resumes without re-fetching.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Wikimedia asks for a descriptive User-Agent with contact details. Set POI_IMAGES_USER_AGENT
 * (e.g. "TeamPoiImages/1.0 (https://example.org; ops@example.org)") before large runs.
 */
export const USER_AGENT = process.env.POI_IMAGES_USER_AGENT?.trim() || 'poi-image-pipeline/0.1 (low-volume batch script; set POI_IMAGES_USER_AGENT for large runs)';
const MAX_IN_FLIGHT = 2;
/** Minimum gap between two requests to the same host (Wikimedia rate limits anonymous clients). */
const HOST_GAP_MS = 400;
const lastByHost = new Map();
async function pace(url, gap = HOST_GAP_MS) {
  const host = new URL(url).host;
  const wait = (lastByHost.get(host) ?? 0) + gap - Date.now();
  lastByHost.set(host, Math.max(Date.now(), (lastByHost.get(host) ?? 0) + gap));
  if (wait > 0) await sleep(wait);
}
let inFlight = 0;
const waiting = [];
async function slot() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return; }
  await new Promise((done) => waiting.push(done));
  inFlight++;
}
function release() {
  inFlight--;
  waiting.shift()?.();
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function createHttp(cacheDir, { log = () => {} } = {}) {
  const stats = { requests: 0, cached: 0, retries: 0 };
  async function cached(key, produce) {
    const file = resolve(cacheDir, createHash('sha1').update(key).digest('hex') + '.json');
    try {
      const hit = JSON.parse(await readFile(file, 'utf8'));
      stats.cached++;
      return hit;
    } catch {}
    const value = await produce();
    // API-level errors (e.g. "too busy") are retried later, so they are never cached.
    if (!value?.error) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(value));
    }
    return value;
  }
  async function request(url, init = {}, kind = 'json', gap) {
    for (let attempt = 0; ; attempt++) {
      await slot();
      await pace(url, gap);
      let response;
      try {
        stats.requests++;
        response = await fetch(url, {
          ...init,
          headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: kind === 'json' ? 'application/json' : '*/*', ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        release();
        if (attempt >= 4) throw error;
        stats.retries++;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      release();
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 5) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
        const after = Number(response.headers.get('retry-after'));
        stats.retries++;
        const where = new URL(url);
        log(`  chờ ${after || 2 ** attempt * 2}s (HTTP ${response.status} ${where.host} ${where.searchParams.get('list') ?? where.searchParams.get('prop') ?? ''})`);
        await sleep((Number.isFinite(after) && after > 0 ? after : 2 * 2 ** attempt) * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
      return kind === 'json' ? response.json() : Buffer.from(await response.arrayBuffer());
    }
  }
  return {
    stats,
    /** Cached JSON GET; `gapMs` spaces out expensive calls (only when not cached). */
    json: (url, { gapMs } = {}) => cached(url, () => request(url, {}, 'json', gapMs)),
    /** Cached SPARQL query (POST, so long queries fit). */
    sparql: (query) =>
      cached(`sparql:${query}`, () =>
        request('https://query.wikidata.org/sparql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
          body: new URLSearchParams({ query, format: 'json' }),
        }),
      ),
    /** Uncached binary GET (only for the photos finally chosen). */
    bytes: (url) => request(url, {}, 'bytes'),
  };
}

/** MediaWiki API GET following `continue` until done (or `max` pages). */
const BUSY = new Set(['cirrussearch-too-busy-error', 'maxlag', 'ratelimited', 'internal_api_error_DBQueryTimeoutError']);
export async function mediawiki(http, base, params, { max = 50, gapMs } = {}) {
  const pages = [];
  let next = {};
  for (let i = 0; i < max; i++) {
    const url = `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params, ...next })}`;
    let body = await http.json(url, { gapMs });
    for (let attempt = 1; body.error && BUSY.has(body.error.code) && attempt <= 6; attempt++) {
      await sleep(15_000 * attempt);
      body = await http.json(url, { gapMs });
    }
    if (body.error) throw new Error(`MediaWiki: ${body.error.code}`);
    pages.push(body);
    if (!body.continue) break;
    next = body.continue;
  }
  return pages;
}
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const wikipediaApi = (lang) => `https://${lang}.wikipedia.org/w/api.php`;
