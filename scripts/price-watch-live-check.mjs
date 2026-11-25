// One real Travelpayouts call with the Automation token, parsed exactly as the
// price worker would. Never prints the token or the upstream body; never enables the worker.
//   PowerShell: $env:TRAVELPAYOUTS_TOKEN="..."; corepack pnpm price-watch:live-check
//   Optional:   PRICE_CHECK_ORIGIN=SGN PRICE_CHECK_DESTINATION=HAN PRICE_CHECK_DATE=2026-12-14
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function checkInput(env = process.env, now = Date.now()) {
  const origin = (env.PRICE_CHECK_ORIGIN ?? 'SGN').trim().toUpperCase();
  const destination = (env.PRICE_CHECK_DESTINATION ?? 'HAN').trim().toUpperCase();
  const departure_date =
    env.PRICE_CHECK_DATE?.trim() || new Date(now + 21 * 86400000).toISOString().slice(0, 10);
  if (!IATA.test(origin) || !IATA.test(destination) || origin === destination)
    throw new Error('PRICE_CHECK_ORIGIN/PRICE_CHECK_DESTINATION must be two different IATA codes.');
  if (!DATE.test(departure_date) || Number.isNaN(Date.parse(`${departure_date}T00:00:00Z`)))
    throw new Error('PRICE_CHECK_DATE must be YYYY-MM-DD.');
  return { origin, destination, departure_date };
}

/** Summarise one provider answer without echoing upstream bodies, tokens or row identifiers. */
export function summarize(query, httpStatus, payload, provider, now = Date.now()) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const currency = typeof payload?.currency === 'string' ? payload.currency.toUpperCase() : null;
  const base = {
    request: query,
    http_status: httpStatus,
    response_currency: currency,
    rows_returned: rows.length,
    rows_for_this_day: rows.filter(
      (row) =>
        row?.origin === query.origin &&
        row?.destination === query.destination &&
        row?.depart_date === query.departure_date,
    ).length,
  };
  if (httpStatus === 401 || httpStatus === 403)
    return {
      ...base,
      status: 'AUTH_FAILED',
      next_step: 'Check the API token in your Travelpayouts profile.',
    };
  if (httpStatus === 429)
    return { ...base, status: 'RATE_LIMITED', next_step: 'Wait a minute and run again.' };
  if (httpStatus < 200 || httpStatus >= 300 || payload?.success !== true)
    return { ...base, status: 'PROVIDER_UNAVAILABLE' };
  if (currency !== null && currency !== 'VND')
    return {
      ...base,
      status: 'CURRENCY_NOT_VND',
      next_step: 'Keep TRAVELPAYOUTS_VND_VERIFIED=false; the worker refuses non-VND prices.',
    };
  let result;
  try {
    result = provider.parseTravelpayouts(
      payload,
      { ...query, provider: 'TRAVELPAYOUTS_CACHE' },
      true,
      now,
    );
  } catch {
    return {
      ...base,
      status: 'RESPONSE_INVALID',
      next_step: 'Keep TRAVELPAYOUTS_VND_VERIFIED=false and report the route/date.',
    };
  }
  if (result.kind === 'NO_RESULT')
    return {
      ...base,
      status: 'NO_CACHED_PRICE',
      next_step:
        'The cache has no fare for this exact day yet (it only holds prices found by Aviasales users). Try another date or a busier route; the worker records NO_RESULT, never price 0.',
    };
  if (!currency)
    return {
      ...base,
      status: 'CURRENCY_UNCONFIRMED',
      next_step:
        'The response did not identify its currency. Verify VND with the provider before enabling the worker.',
    };
  return {
    ...base,
    status: 'OK',
    parsed: {
      price_vnd: result.price,
      provider_found_at: result.fare_metadata.provider_found_at,
      source_freshness: result.fare_metadata.source_freshness,
      alert_eligible: provider.referencePriceFresh(result.provider, result.fare_metadata, now),
    },
    next_step:
      'Currency is VND: set PRICE_WATCH_PROVIDER=TRAVELPAYOUTS_CACHE and TRAVELPAYOUTS_VND_VERIFIED=true for automation-service, then restart the demo.',
  };
}

export async function main(env = process.env, fetcher = fetch) {
  if (process.argv.length > 2) {
    process.stdout.write(
      JSON.stringify({
        status: 'INVALID_ARGUMENTS',
        message: 'Use environment variables, never CLI secrets.',
      }) + '\n',
    );
    process.exitCode = 1;
    return;
  }
  const query = checkInput(env);
  let token = env.TRAVELPAYOUTS_TOKEN?.trim();
  if (!token) {
    try {
      const file = new URL('../apps/automation-service/.env', import.meta.url);
      token = parseEnv(await readFile(file, 'utf8')).TRAVELPAYOUTS_TOKEN?.trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!token) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'NOT_RUN',
          request: query,
          next_step:
            'Set TRAVELPAYOUTS_TOKEN from your Travelpayouts profile in the shell or apps/automation-service/.env, then run again.',
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const provider = require('../apps/automation-service/dist/price-watch/travelpayouts.provider.js');
  const worker = require('../apps/automation-service/dist/price-watch/price-watch-worker.domain.js');
  const tools = {
    parseTravelpayouts: provider.parseTravelpayouts,
    referencePriceFresh: worker.referencePriceFresh,
  };
  let response;
  try {
    response = await fetcher(provider.travelpayoutsUrl(query), {
      headers: { 'X-Access-Token': token, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
  } catch {
    process.stdout.write(
      JSON.stringify({ status: 'PROVIDER_UNAVAILABLE', request: query }, null, 2) + '\n',
    );
    process.exitCode = 1;
    return;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const summary = summarize(query, response.status, payload, tools);
  process.stdout.write(
    JSON.stringify(
      { checked_at: new Date().toISOString(), provider: 'TRAVELPAYOUTS_CACHE', ...summary },
      null,
      2,
    ) + '\n',
  );
  if (!['OK', 'NO_CACHED_PRICE'].includes(summary.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
