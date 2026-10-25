import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { projectRefund, refundRoute } from '../../../apps/api-gateway/src/refund-http';

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-refunds.openapi.json'), 'utf8'),
);
describe('Refund OpenAPI', () => {
  it('documents API111-119 and resolves every local reference', () => {
    expect(Object.keys(document.paths)).toHaveLength(8);
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
  it('matches the strict public projection without audit-only fields', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $ref: '#/components/schemas/Refund',
      components: document.components,
    });
    const id = '10000000-0000-4000-8000-000000000001';
    const value = projectRefund({
      id,
      fund_id: id,
      member_user_id: id,
      amount: '9223372036854775807',
      status: 'CONFIRMED',
      reason: 'Dư',
      confirmed_at: { seconds: '1', nanos: 0 },
      created_at: { seconds: '0', nanos: 0 },
      updated_at: { seconds: '1', nanos: 0 },
      version: 2,
      finance_version: 3,
    });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...value, reversal_reason: 'private' })).toBe(false);
  });
  it('accepts only the documented create and reason-action inputs', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = (name: string) =>
      ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
    const id = '10000000-0000-4000-8000-000000000001';
    expect(
      schema('CreateRefundInput')({
        member_user_id: id,
        amount: '100000',
        reason: 'Dư',
        expected_finance_version: 2,
      }),
    ).toBe(true);
    const reason = schema('ReasonActionInput');
    expect(reason({ reason: 'Chưa nhận', expected_version: 2, expected_finance_version: 3 })).toBe(
      true,
    );
    expect(
      reason({ reason: 'x', expected_version: 2, expected_finance_version: 3, extra: true }),
    ).toBe(false);
  });
  it('rejects extra path segments', () => {
    expect(refundRoute('/api/v1/refunds/id/reverse/extra')).toBeUndefined();
  });
});
