import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { bankRoute, projectBankTransfer } from '../../../apps/api-gateway/src/bank-webhook-http';

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-bank-transfers.openapi.json'), 'utf8'),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schema = (name: string) =>
  ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
const id = '10000000-0000-4000-8000-000000000001';

describe('Bank transfers OpenAPI', () => {
  it('documents the webhook and the Holder read, resolving every local reference', () => {
    expect(Object.keys(document.paths)).toHaveLength(2);
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
    for (const name of Object.keys(document.components.schemas)) schema(name);
  });
  it('maps both documented paths to the router', () => {
    for (const path of Object.keys(document.paths)) {
      const target = path.replace('{provider}', 'sepay').replace(/\{[^}]+\}/g, id);
      expect(bankRoute(target), path).toBeDefined();
      expect(bankRoute(target + '/x'), path).toBeUndefined();
    }
  });
  it('matches the Holder projection and the documented SePay payload', () => {
    const validate = schema('BankTransfer');
    const value = projectBankTransfer({
      id,
      provider: 'SEPAY',
      provider_transaction_id: '92704',
      transfer_type: 'IN',
      amount: '300000',
      content: 'CK 0ABCDEFGHIJKLMNOPQRSTUVWX',
      account_number_masked: '******4567',
      bank_gateway: 'Vietcombank',
      processing_status: 'NEEDS_REVIEW',
      review_reason: 'AMOUNT_MISMATCH',
      transaction_at: { seconds: '1792000000', nanos: 0 },
      received_at: { seconds: '1792000001', nanos: 0 },
      processed_at: { seconds: '1792000001', nanos: 0 },
    });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...value, account_number: '0001234567' })).toBe(false);
    const payload = schema('SepayTransaction');
    expect(
      payload({
        id: 92704,
        gateway: 'Vietcombank',
        transactionDate: '2026-11-12 20:15:00',
        accountNumber: '0001234567',
        content: 'CK',
        transferType: 'in',
        transferAmount: 300000,
        accumulated: 0,
        extra: 1,
      }),
    ).toBe(true);
    expect(
      payload({ id: 1, transferType: 'in', transferAmount: 0, accountNumber: 'x', content: '' }),
    ).toBe(false);
  });
});
