// Read-only provider diagnostics. Never print requests, credentials or upstream error bodies.
import { pathToFileURL } from 'node:url';

export async function probe(provider, url, headers = {}, fetcher = fetch) {
  const start = performance.now();
  try {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
    const base = { provider, http_status: response.status, latency_ms: Math.round(performance.now() - start),
      quota: Object.fromEntries(['x-rate-limit', 'x-rate-limit-remaining', 'x-rate-limit-reset'].map(k => [k, response.headers.get(k)])) };
    if (!response.ok) return { ...base, status: 'BLOCKED_PROVIDER' };
    const payload = await response.json();
    const rows = payload.features ?? payload.results ?? payload.data;
    if (!Array.isArray(rows) || payload.success === false) return { ...base, status: 'INVALID_RESPONSE' };
    const currency = typeof payload.currency === 'string' ? payload.currency.toUpperCase() : null;
    const samples = rows.slice(0, 3).map(row => {
      const p = row.properties ?? row;
      const allowed = provider === 'GEOAPIFY' ? ['name', 'formatted', 'lat', 'lon'] :
        ['origin', 'destination', 'depart_date', 'return_date', 'value', 'trip_class', 'found_at', 'actual', 'currency'];
      return Object.fromEntries(allowed.filter(k => typeof p[k] === 'string' || typeof p[k] === 'number' || typeof p[k] === 'boolean').map(k => [k, typeof p[k] === 'string' ? p[k].slice(0, 200) : p[k]]));
    });
    return { ...base, status: rows.length ? 'REVIEW_REQUIRED' : 'NO_RESULT', count: rows.length, currency, samples };
  } catch { return { provider, status: 'PROVIDER_UNAVAILABLE', latency_ms: Math.round(performance.now() - start) }; }
}

export async function main() {
  if (process.argv.length > 2) { process.stdout.write(JSON.stringify({ status: 'INVALID_ARGUMENTS', message: 'Use environment variables, never CLI secrets.' }) + '\n'); process.exitCode = 1; return; }
  const results = [];
  const geo = process.env.GEOAPIFY_API_KEY;
  if (geo) {
    const urls = [
      new URL('https://api.geoapify.com/v1/geocode/search?text=Da%20Nang%20Vietnam&format=json&limit=5'),
      new URL('https://api.geoapify.com/v2/places?categories=tourism&filter=circle:108.2022,16.0544,5000&limit=20&lang=vi'),
    ];
    for (const url of urls) { url.searchParams.set('apiKey', geo); results.push(await probe('GEOAPIFY', url)); }
  } else results.push({ provider: 'GEOAPIFY', status: 'NOT_RUN' });
  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (token) {
    for (const origin of ['HAN', 'SGN']) for (const days of [14, 30]) {
      const date = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      const url = new URL('https://api.travelpayouts.com/aviasales/v3/get_latest_prices');
      url.search = new URLSearchParams({ origin, destination: 'DAD', period_type: 'day', beginning_of_period: date, one_way: 'true', trip_class: '0', currency: 'vnd', sorting: 'price', limit: '20', page: '1' }).toString();
      results.push({ origin, destination: 'DAD', date, requested_currency: 'VND', ...await probe('TRAVELPAYOUTS_CACHE', url, { 'X-Access-Token': token }) });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } else results.push({ provider: 'TRAVELPAYOUTS_CACHE', status: 'NOT_RUN' });
  process.stdout.write(JSON.stringify({ checked_at: new Date().toISOString(), note: 'Review matching records and currency; this never enables the worker.', results }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
