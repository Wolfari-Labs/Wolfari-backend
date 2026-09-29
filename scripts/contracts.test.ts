import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// JavaScript compatibility tool is shared with the CLI.
// @ts-expect-error Native ESM JavaScript module.
import { eventCompatibilityErrors } from '../packages/contracts/tools/event-compatibility.mjs';

const schemaPath = resolve(process.cwd(), 'packages/contracts/schemas/events-v1.schema.json');
interface EventSchemaFixture {
  definitions: {
    accountStatusChanged: { properties: Record<string, unknown>; required: string[] };
  };
  allOf: Array<{ oneOf?: unknown[] }>;
}
const load = async () => JSON.parse(await readFile(schemaPath, 'utf8')) as EventSchemaFixture;

describe('event compatibility', () => {
  it('allows only an added optional payload field in schema v1', async () => {
    const previous = await load();
    const current = structuredClone(previous);
    current.definitions.accountStatusChanged.properties.optional_note = { type: 'string' };
    expect(eventCompatibilityErrors(previous, current)).toEqual([]);
  });

  it.each([
    ['removed field', (schema: EventSchemaFixture) => { delete schema.definitions.accountStatusChanged.properties.status; }],
    ['changed type', (schema: EventSchemaFixture) => { schema.definitions.accountStatusChanged.properties.status = { type: 'number' }; }],
    ['changed required', (schema: EventSchemaFixture) => { schema.definitions.accountStatusChanged.required.pop(); }],
    ['narrowed enum', (schema: EventSchemaFixture) => {
      const status = schema.definitions.accountStatusChanged.properties.status as { enum: string[] };
      status.enum.pop();
    }],
    ['added event', (schema: EventSchemaFixture) => { schema.allOf[1]!.oneOf!.push({ properties: { event_type: { const: 'NewEvent' }, producer: { const: 'Trip' }, aggregate_type: { const: 'Trip' }, payload: { $ref: '#/definitions/tripRevision' } } }); }],
    ['referenced UUID type', (schema: EventSchemaFixture) => { (schema as unknown as { definitions: { uuid: { type: string } } }).definitions.uuid.type = 'number'; }],
    ['envelope correlation type', (schema: EventSchemaFixture) => { (schema as unknown as { properties: { correlation_id: unknown } }).properties.correlation_id = { type: 'number' }; }],
    ['nested constraint', (schema: EventSchemaFixture) => { (schema as unknown as { definitions: { changedEntity: { properties: { id: unknown } } } }).definitions.changedEntity.properties.id = { type: 'string' }; }],
    ['variant required', (schema: EventSchemaFixture) => { (schema.allOf[1]!.oneOf![0] as { required: string[] }).required = ['producer']; }],
  ])('detects %s as breaking', async (_name, mutate) => {
    const previous = await load();
    const current = structuredClone(previous);
    mutate(current);
    expect(eventCompatibilityErrors(previous, current)).not.toEqual([]);
  });
});
