import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-receipts.openapi.json'), 'utf8'),
);
describe('Finance receipts API contract', () => {
  it('resolves local refs and validates exact FileReference boundaries', () => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        let target: unknown = spec;
        for (const p of String(value.$ref).slice(2).split('/'))
          target = (target as Record<string, unknown>)[p];
        expect(target).toBeDefined();
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(spec);
    expect(Object.keys(spec.paths)).toHaveLength(2);
    const validate = ajv.compile(spec.components.schemas.FileReference);
    const file = {
      object_key: `funds/10000000-0000-4000-8000-000000000001/receipts/10000000-0000-4000-8000-000000000002-${'a'.repeat(64)}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: 10485760,
    };
    expect(validate(file)).toBe(true);
    for (const patch of [
      { size_bytes: 0 },
      { size_bytes: 10485761 },
      { mime_type: 'text/html' },
      { object_key: 'users/avatar.png' },
      { public_url: 'https://test.invalid' },
    ])
      expect(validate({ ...file, ...patch })).toBe(false);
  });
});
