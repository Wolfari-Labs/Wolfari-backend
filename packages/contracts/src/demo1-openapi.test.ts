import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { planRoute, projectActivity, projectPlan } from '../../../apps/api-gateway/src/plan-proxy';
import {
  FinanceProxy,
  projectFund,
  projectDestination,
} from '../../../apps/api-gateway/src/finance-proxy';
import { projectLedgerPage } from '../../../apps/api-gateway/src/ledger-projection';
import type { IncomingMessage, ServerResponse } from 'node:http';

const specs = ['plan', 'finance-fund'].map((name) =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'docs/api/' + name + '.openapi.json'), 'utf8')),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const id = '10000000-0000-4000-8000-000000000001';
const time = { seconds: '1792000000', nanos: 0 };
function check(index: number, name: string, value: unknown) {
  const validate = ajv.compile({
    $ref: '#/components/schemas/' + name,
    components: specs[index].components,
  });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

describe('Demo 1 executable REST contracts', () => {
  it.each([0, 1])('resolves local references and compiles every schema in document %s', (index) => {
    const spec = specs[index];
    function walk(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        const ref = String(value.$ref);
        expect(ref.startsWith('#/')).toBe(true);
        let target = spec;
        for (const part of ref.slice(2).split('/')) target = target?.[part];
        expect(target, ref).toBeDefined();
      }
      for (const child of Object.values(value)) walk(child);
    }
    walk(spec);
    for (const name of Object.keys(spec.components.schemas))
      ajv.compile({
        $ref: '#/components/schemas/' + name,
        components: spec.components,
      });
  });
  it('maps all six documented Plan operations to the real router', () => {
    let count = 0;
    for (const [path, item] of Object.entries(specs[0].paths)) {
      for (const method of Object.keys(item as object).filter((key) =>
        /^(get|post|put|patch|delete)$/.test(key),
      )) {
        const target = path.replace(/\{[^}]+\}/g, id);
        expect(planRoute(method.toUpperCase(), target)).not.toBeNull();
        expect(planRoute(method.toUpperCase(), target + '/unexpected')).toBeNull();
        count++;
      }
    }
    expect(count).toBe(6);
  });
  it('reaches authentication for all eight documented Fund operations (no service/network call)', async () => {
    let count = 0;
    for (const [path, item] of Object.entries(specs[1].paths)) {
      for (const method of Object.keys(item as object).filter((key) =>
        /^(get|post|put|patch|delete)$/.test(key),
      )) {
        const output: { statusCode?: number; body?: string } = {};
        const response = Object.assign(output, {
          setHeader() {},
          end(body: string) {
            output.body = body;
          },
        }) as unknown as ServerResponse;
        const proxy = new FinanceProxy(
          async () => {
            throw new Error('No auth token should reach session lookup');
          },
          {
            call: async () => {
              throw new Error('Unexpected RPC');
            },
            close() {},
          },
        );
        await proxy.handle(
          {
            url: path.replace(/\{[^}]+\}/g, id),
            method: method.toUpperCase(),
            headers: {},
          } as IncomingMessage,
          response,
        );
        expect(output.statusCode, path).toBe(401);
        expect(JSON.parse(output.body!).error.code).toBe('UNAUTHENTICATED');
        count++;
      }
    }
    expect(count).toBe(8);
  });
  it('validates current Gateway Activity/Plan and error envelopes including nulls', () => {
    const activity = {
      id,
      trip_id: id,
      title: 'Day only',
      activity_type: 'OTHER',
      position: 0,
      status: 1,
      source: 1,
      created_by_user_id: id,
      plan_version: 2,
      scheduled_date: '2026-11-01',
    };
    check(0, 'Activity', projectActivity(activity));
    check(0, 'Activity', projectActivity({ ...activity, scheduled_date: undefined }));
    check(
      0,
      'Plan',
      projectPlan({
        trip_id: id,
        plan_version: 2,
        export_revision: 3,
        activities: [activity],
        permissions: { can_read: true, can_edit: true, can_complete: true },
      }),
    );
    for (const index of [0, 1])
      check(index, 'Error', {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Retry', details: null, retryable: true },
        meta: { correlation_id: id },
      });
  });
  it('validates Fund, redacted/private destination and exact-int64 ledger projections', () => {
    check(
      1,
      'Fund',
      projectFund({
        id,
        trip_id: id,
        holder_user_id: id,
        currency: 'VND',
        status: 1,
        current_balance: '9223372036854775807',
        reserved_refund: '0',
        available_balance: '9223372036854775807',
        finance_version: 1,
      }),
    );
    const destination = {
      id,
      fund_id: id,
      destination_type: 1,
      active: true,
      is_default: true,
      version: 1,
    };
    check(1, 'Destination', projectDestination(destination));
    check(
      1,
      'Destination',
      projectDestination({
        ...destination,
        bank_code: 'TEST',
        account_number: '001',
        account_name: 'TEST',
      }),
    );
    check(
      1,
      'LedgerPage',
      projectLedgerPage(
        {
          items: [
            {
              id,
              fund_id: id,
              sequence: '1',
              direction: 1,
              transaction_type: 'CONTRIBUTION',
              amount: '9223372036854775807',
              balance_after: '9223372036854775807',
              created_at: time,
            },
          ],
        },
        id,
        20,
      ),
    );
  });
});
