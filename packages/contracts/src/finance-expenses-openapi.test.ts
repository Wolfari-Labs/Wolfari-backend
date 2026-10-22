import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { projectExpense } from '../../../apps/api-gateway/src/expense-http';

const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-expenses.openapi.json'), 'utf8'),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const id = '10000000-0000-4000-8000-000000000001';

describe('Finance API096-101 OpenAPI', () => {
  it('resolves every local reference and compiles schemas', () => {
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        const ref = String(value.$ref);
        expect(ref.startsWith('#/')).toBe(true);
        let target: unknown = spec;
        for (const part of ref.slice(2).split('/'))
          target = (target as Record<string, unknown>)[part];
        expect(target, ref).toBeDefined();
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(spec);
    expect(Object.keys(spec.paths)).toHaveLength(4);
    for (const name of [
      'CreateExpenseInput',
      'UpdateExpenseInput',
      'ExpenseActionInput',
      'Expense',
      'ExpenseEnvelope',
      'ExpensePageEnvelope',
    ])
      expect(() =>
        ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }),
      ).not.toThrow();
  });

  it('matches the actual public projection and rejects private object keys', () => {
    const expense = projectExpense({
      id,
      fund_id: id,
      title: 'Taxi',
      amount: '9007199254740993',
      status: 'DRAFT',
      created_by_user_id: id,
      receipt_available: true,
      created_at: { seconds: '1792630923', nanos: 0 },
      updated_at: { seconds: '1792630923', nanos: 0 },
      version: 1,
      finance_version: 4,
    });
    const validate = ajv.compile({
      $ref: '#/components/schemas/Expense',
      components: spec.components,
    });
    expect(validate(expense), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...expense, receipt_object_key: 'private/key' })).toBe(false);
    expect(validate({ ...expense, amount: 9007199254740993 })).toBe(false);
  });
});
