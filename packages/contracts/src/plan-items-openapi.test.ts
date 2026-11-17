import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { planItemRoute } from '../../../apps/api-gateway/src/plan-items-proxy';
import { projectDressCode, projectPackingItem } from '../../../apps/api-gateway/src/plan-proxy';

const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/plan-items.openapi.json'), 'utf8'),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const id = '10000000-0000-4000-8000-000000000001';
const validate = (name: string, value: unknown) =>
  ajv.compile({ $ref: '#/components/schemas/' + name, components: spec.components })(value);
describe('shared Plan collection OpenAPI', () => {
  it('maps all documented collection actions to the actual Gateway router', () => {
    let count = 0;
    for (const [path, item] of Object.entries(spec.paths))
      for (const method of Object.keys(item as object)) {
        expect(planItemRoute(method.toUpperCase(), path.replace(/\{[^}]+\}/g, id))).not.toBeNull();
        count++;
      }
    expect(count).toBe(7);
    for (const name of Object.keys(spec.components.schemas))
      ajv.compile({ $ref: '#/components/schemas/' + name, components: spec.components });
  });
  it('accepts public row projections and preserves nullable fields', () => {
    expect(
      validate(
        'DressCode',
        projectDressCode({
          id,
          trip_id: id,
          scope_type: 1,
          label: 'White',
          source: 1,
          plan_version: 2,
        }),
      ),
    ).toBe(true);
    expect(
      validate(
        'PackingItem',
        projectPackingItem({
          id,
          trip_id: id,
          name: 'Water',
          quantity: '1.25',
          source: 1,
          status: 1,
          plan_version: 2,
        }),
      ),
    ).toBe(true);
    expect(
      validate('CreatePacking', {
        name: 'Water',
        quantity: '1.25',
        assigned_member_id: id,
        due_at: null,
        expected_plan_version: 2,
      }),
    ).toBe(true);
    expect(
      validate('CreateDress', {
        scope_type: 'TRIP',
        label: 'White',
        plan_date: null,
        activity_id: null,
        expected_plan_version: 2,
      }),
    ).toBe(true);
    expect(
      validate('CreatePacking', { name: 'Water', expected_plan_version: 2, status: 'COMPLETED' }),
    ).toBe(false);
    expect(validate('Completion', { status: 'COMPLETED', expected_plan_version: 0 })).toBe(false);
  });
});
