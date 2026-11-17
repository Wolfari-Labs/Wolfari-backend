import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { PlanItemsService, normalizeItemFields } from './plan-items.service';

const actor = '10000000-0000-4000-8000-000000000001',
  trip = '20000000-0000-4000-8000-000000000001',
  item = '30000000-0000-4000-8000-000000000001',
  operation = '40000000-0000-4000-8000-000000000001';
const access = {
  id: trip,
  start_at: '2026-12-01T00:00:00Z',
  end_at: '2026-12-03T00:00:00Z',
  timezone: 'UTC',
  role: 'OWNER',
  selected_editor: false,
  membership_id: actor,
  plan_edit_policy: 'OWNER_ONLY',
  plan_version: 4,
  export_revision: 7,
  archived_at: null,
};
const row = {
  id: item,
  trip_id: trip,
  scope_type: 'TRIP',
  plan_date: null,
  activity_id: null,
  label: 'White',
  description: null,
  public_description: null,
  source: 'MANUAL',
  name: 'Water',
  quantity: '1.00',
  unit: null,
  note: null,
  category: null,
  due_at: null,
  assigned_member_id: null,
  status: 'TODO',
  completed_by_user_id: null,
  completed_at: null,
};
const command = {
  actor_user_id: actor,
  operation_id: operation,
  trip_id: trip,
  expected_plan_version: 4,
  entity_type: 'DRESS_CODE',
  action: 'CREATE',
  fields_json: JSON.stringify({ scope_type: 'TRIP', label: 'White' }),
};
function harness(overrides: Partial<typeof access> = {}, saved?: unknown, activeMember = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM trips t JOIN'))
      return { rows: [{ ...access, ...overrides }], rowCount: 1 };
    if (sql.includes('FROM trip_operations'))
      return { rows: saved ? [saved] : [], rowCount: saved ? 1 : 0 };
    if (sql.includes('FROM trip_members WHERE'))
      return { rows: [], rowCount: activeMember ? 1 : 0 };
    if (sql.includes('AS valid')) return { rows: [{ valid: true }], rowCount: 1 };
    if (sql.includes('FROM dress_codes') || sql.includes('FROM packing_items'))
      return { rows: [row], rowCount: 1 };
    if (sql.startsWith('INSERT INTO dress_codes') || sql.startsWith('INSERT INTO packing_items'))
      return { rows: [{ id: item }], rowCount: 1 };
    if (sql.startsWith('UPDATE trips SET'))
      return { rows: [{ trip_id: trip, plan_version: 5, export_revision: 8 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const db = {
    withTransaction: async (work: (client: { query: typeof query }) => Promise<unknown>) =>
      work({ query }),
  };
  return { service: new PlanItemsService(db as unknown as DatabaseProvider), query };
}
describe('shared Plan collections', () => {
  it('rejects field injection, invalid decimals and malformed scopes before writes', () => {
    expect(() =>
      normalizeItemFields('PACKING_ITEM', 'CREATE', { name: 'Water', quantity: '1.234' }),
    ).toThrow();
    expect(() =>
      normalizeItemFields('PACKING_ITEM', 'UPDATE', { name: 'Water', status: 'COMPLETED' }),
    ).toThrow();
    expect(() =>
      normalizeItemFields('DRESS_CODE', 'CREATE', { label: 'x', scope_type: 'UNKNOWN' }),
    ).toThrow();
    expect(() =>
      normalizeItemFields('PACKING_ITEM', 'CREATE', { name: 'x', quantity: '0' }),
    ).toThrow();
    expect(
      normalizeItemFields('PACKING_ITEM', 'CREATE', { name: ' Water ', quantity: '1.25' }),
    ).toMatchObject({ name: 'Water', quantity: '1.25', due_at: null });
  });
  it('uses one transaction for item, plan revision, audit, outbox and receipt', async () => {
    const { service, query } = harness();
    const result = await service.mutate(command, operation);
    expect(result.version).toEqual({ trip_id: trip, plan_version: 5, export_revision: 8 });
    expect(result.item).toMatchObject({ id: item, label: 'White' });
    const sql = query.mock.calls.map(([sql]) => sql);
    for (const table of ['dress_codes', 'trip_audit_logs', 'outbox_events', 'trip_operations'])
      expect(sql.some((value) => value.startsWith('INSERT INTO ' + table))).toBe(true);
    expect(sql[0]).toContain('pg_advisory_xact_lock');
    expect(sql[1]).toContain('FOR UPDATE');
  });
  it('does not write for viewers, archived trips or stale versions', async () => {
    for (const override of [
      { role: 'MEMBER' },
      { archived_at: '2026-12-01T00:00:00Z' },
      { plan_version: 6 },
    ]) {
      const { service, query } = harness(override as Partial<typeof access>);
      await expect(service.mutate(command, operation)).rejects.toThrow();
      expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    }
  });
  it('replays a matching receipt without another mutation and rejects changed intent', async () => {
    const first = harness();
    await first.service.mutate(command, operation);
    const insert = first.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO trip_operations'),
    ) as unknown as [string, unknown[]];
    const values = insert[1];
    const receipt = {
      operation_type: values[2],
      actor_user_id: actor,
      trip_id: trip,
      request_hash: values[4],
      state: 'SUCCEEDED',
      outcome: values[6],
    };
    const replay = harness({}, receipt);
    expect((await replay.service.mutate(command, operation)).version.plan_version).toBe(5);
    expect(replay.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    await expect(
      replay.service.mutate(
        { ...command, fields_json: JSON.stringify({ scope_type: 'TRIP', label: 'Changed' }) },
        operation,
      ),
    ).rejects.toThrow();
  });
  it('validates references within this Trip and completion membership ownership', async () => {
    const base = {
      ...command,
      entity_type: 'PACKING_ITEM',
      fields_json: JSON.stringify({ name: 'Water', assigned_member_id: actor }),
    };
    await expect(harness({}, undefined, false).service.mutate(base, operation)).rejects.toThrow();
    const complete = {
      ...base,
      action: 'COMPLETE',
      item_id: item,
      fields_json: JSON.stringify({ status: 'TODO' }),
    };
    await expect(harness({ role: 'MEMBER' }).service.mutate(complete, operation)).rejects.toThrow();
  });
});
