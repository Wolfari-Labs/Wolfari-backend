import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { handoverRoute, projectHandover } from '../../../apps/api-gateway/src/handover-http';

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-handovers.openapi.json'), 'utf8'),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schema = (name: string) =>
  ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const time = { seconds: '1792000000', nanos: 0 };
const fingerprint = 'a'.repeat(64);
const nominated = {
  id,
  fund_id: id,
  old_holder_user_id: id,
  new_holder_user_id: other,
  nominated_by_user_id: id,
  status: 'NOMINATED',
  version: 1,
  finance_version: 3,
  snapshot_stale: false,
  created_at: time,
  updated_at: time,
};
const snapshot = {
  current_balance: '0',
  reserved_refund: '0',
  available_balance: '9223372036854775807',
  ledger_sequence: '12',
  fingerprint,
  pending_contribution_ids: [id],
  pending_refund_ids: [],
  pending_expense_ids: [],
  pending_payment_ids: [other],
  payment_destination_ids: [id],
  pending_payment_exception_ids: [],
};

describe('Holder handover OpenAPI', () => {
  it('documents the seven workflow operations and resolves every local reference', () => {
    const operations = Object.values(document.paths).flatMap((item) =>
      Object.keys(item as object).filter((key) => /^(get|post|put|patch|delete)$/.test(key)),
    );
    expect(Object.keys(document.paths)).toHaveLength(6);
    expect(operations).toHaveLength(7);
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
  it('maps every documented path to the real router and rejects extra segments', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      const target = path.replace(/\{[^}]+\}/g, id);
      const route = handoverRoute(target);
      expect(route, path).toBeDefined();
      expect(route?.kind).toBe(path.includes('/funds/') ? 'collection' : 'item');
      expect(handoverRoute(target + '/unexpected'), path).toBeUndefined();
      expect(Object.keys(item as object).some((key) => /^(get|post)$/.test(key))).toBe(true);
    }
    expect(handoverRoute(`/api/v1/holder-handovers/${id}/transfer`)).toBeUndefined();
  });
  it('matches the strict public projection before and after acceptance', () => {
    const validate = schema('Handover');
    const first = projectHandover(nominated);
    expect(validate(first), JSON.stringify(validate.errors)).toBe(true);
    expect(first.snapshot).toBeNull();
    expect(first.snapshot_finance_version).toBeNull();
    expect(first.cancellation_reason).toBeNull();
    const accepted = projectHandover({
      ...nominated,
      status: 'ACCEPTED',
      version: 2,
      snapshot_finance_version: 3,
      snapshot,
      accepted_at: time,
      old_holder_confirmed_at: time,
    });
    expect(validate(accepted), JSON.stringify(validate.errors)).toBe(true);
    expect(accepted.snapshot).toEqual(snapshot);
    expect(accepted.new_holder_confirmed_at).toBeNull();
    expect(validate({ ...accepted, snapshot_stale_override: true })).toBe(false);
    expect(validate({ ...accepted, status: 'TRANSFERRED' })).toBe(false);
    expect(validate({ ...accepted, snapshot: { ...snapshot, current_balance: '-1' } })).toBe(false);
  });
  it('fails closed on malformed Finance responses instead of publishing them', () => {
    expect(() => projectHandover({ ...nominated, snapshot_stale: 'no' })).toThrow();
    expect(() =>
      projectHandover({ ...nominated, snapshot: { ...snapshot, fingerprint: 'short' } }),
    ).toThrow();
    expect(() =>
      projectHandover({ ...nominated, snapshot: { ...snapshot, current_balance: '01' } }),
    ).toThrow();
    expect(() =>
      projectHandover({ ...nominated, snapshot: { ...snapshot, pending_refund_ids: 'x' } }),
    ).toThrow();
  });
  it('accepts only the documented request bodies', () => {
    const create = schema('CreateHandoverInput');
    const action = schema('ActionInput');
    const confirm = schema('ConfirmInput');
    const cancel = schema('CancelInput');
    expect(create({ new_holder_user_id: id, expected_finance_version: 1 })).toBe(true);
    expect(create({ new_holder_user_id: 'bad', expected_finance_version: 1 })).toBe(false);
    expect(create({ new_holder_user_id: id, expected_finance_version: 1, reason: 'x' })).toBe(
      false,
    );
    expect(action({ expected_version: 1, expected_finance_version: 2 })).toBe(true);
    expect(action({ expected_version: 0, expected_finance_version: 2 })).toBe(false);
    expect(confirm({ expected_version: 1, expected_finance_version: 2 })).toBe(false);
    expect(
      confirm({
        expected_version: 1,
        expected_finance_version: 2,
        expected_snapshot_finance_version: 2,
      }),
    ).toBe(true);
    expect(cancel({ expected_version: 1, expected_finance_version: 2, reason: '' })).toBe(false);
    expect(
      cancel({ expected_version: 1, expected_finance_version: 2, reason: 'Không tiếp nhận' }),
    ).toBe(true);
    expect(
      cancel({ expected_version: 1, expected_finance_version: 2, reason: 'x'.repeat(1025) }),
    ).toBe(false);
  });
});
