import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { closureRoute, projectClosure } from '../../../apps/api-gateway/src/closure-http';

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-closures.openapi.json'), 'utf8'),
);
describe('Closure OpenAPI', () => {
  it('documents API120-125 and resolves every local reference', () => {
    expect(Object.keys(document.paths)).toHaveLength(5);
    expect(
      Object.values(document.paths).flatMap((path) => Object.keys(path as object)),
    ).toHaveLength(6);
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        let target: unknown = document;
        for (const part of String(value.$ref).slice(2).split('/'))
          target = (target as Record<string, unknown>)[part];
        expect(target, String(value.$ref)).toBeDefined();
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(document);
  });
  it('validates the strict public projection and excludes payment secrets', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $ref: '#/components/schemas/Closure',
      components: document.components,
    });
    const id = '10000000-0000-4000-8000-000000000001';
    const value = projectClosure({
      id,
      fund_id: id,
      requested_by_user_id: id,
      status: 'PENDING_CONFIRMATIONS',
      snapshot_finance_version: 2,
      snapshot_schema_version: 1,
      snapshot_json: JSON.stringify({
        schema_version: 1,
        fund: {
          id,
          trip_id: id,
          holder_user_id: id,
          currency: 'VND',
          budget_amount: null,
          current_balance: '0',
          finance_version: 2,
        },
        required_user_ids: [id],
        contribution_requests: [],
        contributions: [],
        expenses: [],
        financial_notes: [],
        refunds: [],
        ledger: [],
      }),
      snapshot_hash: 'a'.repeat(64),
      requested_at: { seconds: '1', nanos: 0 },
      confirmations: [{ user_id: id }],
      finance_version: 2,
    });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...value, account_number: 'private' })).toBe(false);
  });
  it('keeps create, confirm, cancel and remind bodies strict', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const schema = (name: string) =>
      ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
    expect(schema('CreateClosureInput')({ expected_finance_version: 2 })).toBe(true);
    expect(schema('ConfirmClosureInput')({ snapshot_hash: 'a'.repeat(64) })).toBe(true);
    expect(schema('CancelClosureInput')({ reason: 'Điều chỉnh' })).toBe(true);
    expect(schema('EmptyInput')({})).toBe(true);
    expect(schema('EmptyInput')({ extra: true })).toBe(false);
  });
  it('rejects extra action path segments', () => {
    expect(closureRoute('/api/v1/closures/id/confirm/extra')).toBeUndefined();
  });
});
