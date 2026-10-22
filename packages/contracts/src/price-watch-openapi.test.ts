import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const document = readFileSync(resolve(process.cwd(), 'docs/api/price-watch.openapi.yaml'), 'utf8');

describe('Price Watch OpenAPI', () => {
  it('documents API133–139 exactly once and keeps internal fields private', () => {
    for (const operation of [
      'createPriceWatch',
      'listPriceWatches',
      'updatePriceWatch',
      'pausePriceWatch',
      'resumePriceWatch',
      'stopPriceWatch',
      'listPriceObservations',
    ]) {
      expect(document.match(new RegExp(`operationId: ${operation}\\b`, 'g'))).toHaveLength(1);
    }
    for (const forbidden of [
      'owner_membership_id',
      'request_hash',
      'client_request_id',
      'private_url',
      'service_secret',
    ])
      expect(document).not.toContain(forbidden);
  });

  it('requires bearer auth, create idempotency and optimistic versions', () => {
    expect(document).toContain('security:\n  - bearer: []');
    expect(document).toContain('name: Idempotency-Key');
    expect(document).toContain('required: [expected_version]');
    expect(document).toContain('current_version');
  });
});
