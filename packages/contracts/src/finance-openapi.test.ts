import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  projectContribution,
  projectContributionRequest,
} from '../../../apps/api-gateway/src/contribution-request-http';

const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-contributions.openapi.json'), 'utf8'),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateSchema = (name: string, value: unknown) => {
  const validate = ajv.compile({
    $ref: '#/components/schemas/' + name,
    components: spec.components,
  });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
};
const id = '10000000-0000-4000-8000-000000000001';
const allocation = {
  id,
  request_id: id,
  fund_id: id,
  member_user_id: id,
  amount: '9223372036854775807',
  status: 'PENDING',
  self_contribution: false,
  version: 1,
  finance_version: 3,
};
const request = {
  id,
  fund_id: id,
  title: 'Meals',
  status: 'OPEN',
  version: 1,
  created_by_user_id: id,
  created_at: { seconds: '1792000000', nanos: 0 },
};
describe('Finance API078–084 OpenAPI', () => {
  it('resolves every local reference and compiles all documented response schemas', () => {
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
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths)).toHaveLength(9);
    for (const path of Object.values(spec.paths) as {
      get?: {
        parameters: { name: string }[];
        responses: Record<
          string,
          {
            content: Record<
              string,
              { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> }
            >;
          }
        >;
      };
      post?: {
        responses: Record<
          string,
          {
            content: Record<
              string,
              { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> }
            >;
          }
        >;
      };
    }[]) {
      if (path.get) expect(path.get.parameters.map((p) => p.name)).toContain('cursor');
      for (const method of Object.values(path))
        for (const response of Object.values(method.responses)) {
          const content = response.content['application/json'];
          const validate = ajv.compile({ ...content.schema, components: spec.components });
          if (content.example)
            expect(validate(content.example), JSON.stringify(validate.errors)).toBe(true);
          for (const example of Object.values(content.examples ?? {}))
            expect(validate(example.value), JSON.stringify(validate.errors)).toBe(true);
        }
    }
  });
  it('matches actual projection shapes for new POST, legacy replay and current GET', () => {
    validateSchema('LegacyCreatedRequest', projectContributionRequest(request));
    validateSchema(
      'CreatedRequest',
      projectContributionRequest({ ...request, finance_version: 3, contributions: [allocation] }),
    );
    validateSchema(
      'ContributionRequest',
      projectContributionRequest(
        {
          ...request,
          status: 'CLOSED',
          version: 5,
          finance_version: 9,
          contributions: [{ ...allocation, status: 'REVERSED', version: 4, finance_version: 9 }],
        },
        false,
      ),
    );
    for (const status of [
      'PENDING',
      'TRANSFER_REPORTED',
      'CONFIRMED',
      'WAIVED',
      'CANCELLED',
      'REVERSED',
    ])
      validateSchema('Contribution', projectContribution({ ...allocation, status }));
    const validate = ajv.compile({
      $ref: '#/components/schemas/Contribution',
      components: spec.components,
    });
    expect(validate({ ...projectContribution(allocation), amount: 9007199254740993 })).toBe(false);
    expect(
      validate({ ...projectContribution(allocation), destination_snapshot: { bank: 'private' } }),
    ).toBe(false);
  });
});
