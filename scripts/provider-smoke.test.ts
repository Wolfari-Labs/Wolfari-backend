import { expect, it } from 'vitest';
// @ts-expect-error Native ESM diagnostic script.
import { probe } from './provider-smoke.mjs';
it('smoke filters secrets, error bodies and unapproved fields', async () => {
  const fake = async () =>
    new Response(
      JSON.stringify({
        data: [{ origin: 'HAN', value: 123, cookie: 'hidden', token: 'hidden', url: 'hidden' }],
        success: true,
      }),
    );
  const result = await probe(
    'TRAVELPAYOUTS_CACHE',
    'https://example.invalid/?secret=hidden',
    { 'X-Access-Token': 'hidden' },
    fake,
  );
  expect(JSON.stringify(result)).not.toContain('hidden');
  expect(result.status).toBe('REVIEW_REQUIRED');
  const denied = await probe(
    'GEOAPIFY',
    'x',
    {},
    async () => new Response('secret upstream', { status: 401 }),
  );
  expect(JSON.stringify(denied)).not.toContain('secret');
  expect(denied.status).toBe('BLOCKED_PROVIDER');
});
it('HTTP 200 empty is not provider PASS', async () =>
  expect(
    (
      await probe(
        'TRAVELPAYOUTS_CACHE',
        'x',
        {},
        async () => new Response('{"success":true,"data":[]}'),
      )
    ).status,
  ).toBe('NO_RESULT'));
