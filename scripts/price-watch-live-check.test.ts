import { describe, expect, it } from 'vitest';
import { parseTravelpayouts } from '../apps/automation-service/src/price-watch/travelpayouts.provider';
import { referencePriceFresh } from '../apps/automation-service/src/price-watch/price-watch-worker.domain';
// @ts-expect-error CLI is native ESM JavaScript.
import { checkInput, summarize } from './price-watch-live-check.mjs';

const tools = { parseTravelpayouts, referencePriceFresh };
const now = Date.parse('2026-11-23T12:00:00Z');
const query = { origin: 'SGN', destination: 'HAN', departure_date: '2026-12-14' };
const row = {
  origin: 'SGN',
  destination: 'HAN',
  depart_date: '2026-12-14',
  return_date: '',
  value: 1290000,
  found_at: '2026-11-23T08:00:00Z',
  actual: true,
};

describe('price-watch live check', () => {
  it('defaults to SGN→HAN three weeks ahead and validates overrides', () => {
    expect(checkInput({}, now)).toEqual({
      origin: 'SGN',
      destination: 'HAN',
      departure_date: '2026-12-14',
    });
    expect(checkInput({ PRICE_CHECK_ORIGIN: 'dad', PRICE_CHECK_DATE: '2027-01-02' }, now)).toEqual({
      origin: 'DAD',
      destination: 'HAN',
      departure_date: '2027-01-02',
    });
    expect(() => checkInput({ PRICE_CHECK_ORIGIN: 'HAN' }, now)).toThrow();
    expect(() => checkInput({ PRICE_CHECK_DATE: '14/12/2026' }, now)).toThrow();
  });
  it('reports the parsed VND price, freshness and alert eligibility', () =>
    expect(
      summarize(query, 200, { success: true, currency: 'vnd', data: [row] }, tools, now),
    ).toMatchObject({
      status: 'OK',
      response_currency: 'VND',
      rows_for_this_day: 1,
      parsed: { price_vnd: '1290000', source_freshness: 'FRESH_REFERENCE', alert_eligible: true },
    }));
  it('explains an empty cache, wrong currency, auth and rate-limit answers', () => {
    expect(summarize(query, 200, { success: true, data: [] }, tools, now).status).toBe(
      'NO_CACHED_PRICE',
    );
    expect(
      summarize(query, 200, { success: true, currency: 'rub', data: [row] }, tools, now).status,
    ).toBe('CURRENCY_NOT_VND');
    expect(summarize(query, 401, null, tools, now).status).toBe('AUTH_FAILED');
    expect(summarize(query, 429, null, tools, now).status).toBe('RATE_LIMITED');
  });
  it('does not confirm VND when a priced response omits its currency', () => {
    expect(summarize(query, 200, { success: true, data: [row] }, tools, now)).toMatchObject({
      status: 'CURRENCY_UNCONFIRMED',
      response_currency: null,
    });
  });
  it('never echoes upstream row details beyond counts', () => {
    const output = JSON.stringify(
      summarize(
        query,
        200,
        { success: true, currency: 'vnd', data: [{ ...row, gate: 'secret-gate' }] },
        tools,
        now,
      ),
    );
    expect(output).not.toContain('secret-gate');
  });
});
