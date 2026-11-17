import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import {
  DressCodeService,
  assertDressScope,
  dressCodeRequestHash,
  normalizeDressCodeFields,
} from '../apps/trip-workspace-service/src/planning/dress-code.service';
import type { AccessRow } from '../apps/trip-workspace-service/src/planning/plan.projection';
import { dressCodeRequest, planRoute, projectPlan } from '../apps/api-gateway/src/plan-proxy';

const actor = '10000000-0000-4000-8000-00000000000a';
const trip = '20000000-0000-4000-8000-00000000000b';
const activity = '30000000-0000-4000-8000-00000000000c';
const operation = '40000000-0000-4000-8000-00000000000d';
const dress = '50000000-0000-4000-8000-00000000000e';
const base = {
  actorUserId: actor,
  tripId: trip,
  operationId: operation,
  correlationId: operation,
  expectedPlanVersion: 4,
};
const access: AccessRow = {
  id: trip,
  timezone: 'Asia/Ho_Chi_Minh',
  start_at: '2026-10-01T00:00:00Z',
  end_at: '2026-10-03T00:00:00Z',
  plan_edit_policy: 'OWNER_ONLY',
  plan_version: 4,
  export_revision: 7,
  archived_at: null,
  membership_id: activity,
  role: 'OWNER',
  selected_editor: false,
};
const stored = {
  id: dress,
  trip_id: trip,
  scope_type: 'DAY',
  plan_date: '2026-10-02',
  activity_id: null,
  label: 'Beachwear',
  description: null,
  public_description: null,
  source: 'DSS',
};
type Options = {
  row?: AccessRow | null;
  receipt?: unknown;
  existing?: unknown;
  dayValid?: boolean;
  activityFound?: boolean;
};
function mock(options: Options = {}) {
  const row = options.row === undefined ? access : options.row;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM trips t JOIN trip_members')) return { rows: row ? [row] : [] };
    if (sql.includes('FROM trip_operations'))
      return { rows: options.receipt ? [options.receipt] : [] };
    if (sql.includes('FROM dress_codes') && sql.includes('FOR UPDATE'))
      return { rows: options.existing ? [options.existing] : [] };
    if (sql.includes('day_start')) return { rows: [{ valid: options.dayValid ?? true }] };
    if (sql.includes('FROM activities'))
      return { rows: (options.activityFound ?? true) ? [{ id: activity }] : [] };
    if (sql.includes('INSERT INTO dress_codes'))
      return {
        rows: [
          {
            ...stored,
            source: 'MANUAL',
            scope_type: params![1],
            plan_date: params![2],
            activity_id: params![3],
            label: params![4],
            description: params![5],
            public_description: params![6],
          },
        ],
      };
    if (sql.includes('UPDATE dress_codes'))
      return {
        rows: [
          {
            ...stored,
            scope_type: params![2],
            plan_date: params![3],
            activity_id: params![4],
            label: params![5],
            description: params![6],
            public_description: params![7],
          },
        ],
      };
    if (sql.includes('UPDATE trips'))
      return { rows: [{ trip_id: trip, plan_version: 5, export_revision: 8 }] };
    return { rows: [] };
  });
  const db = {
    withTransaction: vi.fn(async (work: (client: unknown) => unknown) => work({ query })),
  };
  return { service: new DressCodeService(db as unknown as DatabaseProvider), db, query };
}
const wrote = (query: ReturnType<typeof mock>['query']) =>
  query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql));
const day = { scope_type: 'DAY', plan_date: '2026-10-02', label: 'Beachwear' };

describe('Dress code validation', () => {
  it.each([
    { label: '' },
    { label: '   ' },
    { label: 'x'.repeat(101) },
    { scope_type: 'WEEK' },
    { scope_type: undefined },
    { plan_date: '2026-02-30' },
    { plan_date: null },
    { activity_id: activity },
    { scope_type: 'TRIP' },
    { scope_type: 'ACTIVITY' },
    { scope_type: 'ACTIVITY', plan_date: null, activity_id: 'bad' },
    { description: 'x'.repeat(10_001) },
    { description: 7 },
    { source: 'DSS' },
  ])('rejects invalid creation before BEGIN: %j', async (override) => {
    const { service, db } = mock();
    await expect(
      service.createDressCode({ ...base, fields: { ...day, ...override } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
  it('accepts exactly one scope and its own reference', () => {
    for (const valid of [
      { scope_type: 'TRIP' },
      { scope_type: 'DAY', plan_date: '2026-10-02' },
      { scope_type: 'ACTIVITY', activity_id: activity },
    ] as const)
      expect(() => assertDressScope(valid)).not.toThrow();
    expect(() =>
      assertDressScope({ scope_type: 'DAY', plan_date: '2026-10-02', activity_id: activity }),
    ).toThrow();
  });
  it('trims labels, stores blank descriptions as null and rejects empty PATCH', () => {
    expect(
      normalizeDressCodeFields(
        { scope_type: 'TRIP', label: '  Smart casual ', description: ' ' },
        true,
      ),
    ).toEqual({
      scope_type: 'TRIP',
      plan_date: null,
      activity_id: null,
      label: 'Smart casual',
      description: null,
      public_description: null,
    });
    expect(normalizeDressCodeFields({ label: 'Only label' }, false)).toEqual({
      label: 'Only label',
    });
    expect(() => normalizeDressCodeFields({}, false)).toThrow();
  });
  it('hashes the normalized command independent of field order', () => {
    const command = (fields: unknown) => ({
      ...base,
      command: 'CREATE_DRESS_CODE' as const,
      fields: normalizeDressCodeFields(fields, true),
    });
    expect(dressCodeRequestHash(command(day))).toBe(
      dressCodeRequestHash(
        command({ label: ' Beachwear ', plan_date: '2026-10-02', scope_type: 'DAY' }),
      ),
    );
    expect(dressCodeRequestHash(command(day))).not.toBe(
      dressCodeRequestHash(command({ ...day, label: 'Other' })),
    );
  });
});

describe('Dress code writes', () => {
  it('creates a MANUAL DAY dress code with one revision, audit, event and receipt', async () => {
    const { service, query } = mock();
    const result = await service.createDressCode({ ...base, fields: day });
    expect(result.version).toEqual({ trip_id: trip, plan_version: 5, export_revision: 8 });
    expect(result.dress_code).toMatchObject({
      scope_type: 'DAY',
      plan_date: '2026-10-02',
      source: 'MANUAL',
      plan_version: 5,
    });
    const statements = query.mock.calls.map(([sql]) => sql);
    for (const table of ['trip_audit_logs', 'outbox_events', 'trip_operations'])
      expect(statements.filter((sql) => sql.includes(`INSERT INTO ${table}`))).toHaveLength(1);
    const event = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO outbox_events'))!;
    expect(JSON.parse(String(event[1]![5])).changed_entities).toEqual([
      { type: 'DRESS_CODE', id: dress, action: 'UPSERT' },
    ]);
  });
  it('rejects a day outside the Trip and an activity of another Trip without writing', async () => {
    const outside = mock({ dayValid: false });
    await expect(outside.service.createDressCode({ ...base, fields: day })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const foreign = mock({ activityFound: false });
    await expect(
      foreign.service.createDressCode({
        ...base,
        fields: { scope_type: 'ACTIVITY', activity_id: activity, label: 'Formal' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const m of [outside, foreign]) expect(wrote(m.query)).toBe(false);
  });
  it('denies non-editors before reading receipts, and reports stale or archived Plans', async () => {
    const member = mock({ row: { ...access, role: 'MEMBER' }, receipt: {} });
    await expect(member.service.createDressCode({ ...base, fields: day })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(member.query.mock.calls.some(([sql]) => sql.includes('trip_operations'))).toBe(false);
    const outsider = mock({ row: null });
    await expect(outsider.service.createDressCode({ ...base, fields: day })).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    const stale = mock();
    await expect(
      stale.service.createDressCode({ ...base, expectedPlanVersion: 3, fields: day }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { plan_version: 4, export_revision: 7 },
    });
    const archived = mock({ row: { ...access, archived_at: access.end_at } });
    await expect(archived.service.createDressCode({ ...base, fields: day })).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    for (const m of [member, outsider, stale, archived]) expect(wrote(m.query)).toBe(false);
  });
  it('validates the merged scope on PATCH and keeps the source of an edited suggestion', async () => {
    const toTrip = mock({ existing: stored });
    await expect(
      toTrip.service.updateDressCode({
        ...base,
        dressCodeId: dress,
        fields: { scope_type: 'TRIP' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(wrote(toTrip.query)).toBe(false);
    const { service } = mock({ existing: stored });
    const result = await service.updateDressCode({
      ...base,
      dressCodeId: dress,
      fields: { scope_type: 'TRIP', plan_date: null, label: 'All trip' },
    });
    expect(result.dress_code).toMatchObject({
      scope_type: 'TRIP',
      plan_date: null,
      label: 'All trip',
      source: 'DSS',
      plan_version: 5,
    });
  });
  it('does not revise the Plan for an unchanged PATCH or a missing dress code', async () => {
    const same = mock({ existing: stored });
    const result = await same.service.updateDressCode({
      ...base,
      dressCodeId: dress,
      fields: { label: 'Beachwear' },
    });
    expect(result.version.plan_version).toBe(4);
    expect(same.query.mock.calls.some(([sql]) => sql.includes('UPDATE trips'))).toBe(false);
    const missing = mock();
    await expect(
      missing.service.deleteDressCode({ ...base, dressCodeId: dress }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('deletes with a tombstone and replays the saved outcome after deletion', async () => {
    const { service, query } = mock({ existing: stored });
    const result = await service.deleteDressCode({ ...base, dressCodeId: dress });
    expect(result).toEqual({ version: { trip_id: trip, plan_version: 5, export_revision: 8 } });
    const event = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO outbox_events'))!;
    expect(JSON.parse(String(event[1]![5])).tombstones).toEqual([
      { type: 'DRESS_CODE', id: dress, source_version: 5 },
    ]);
    const command = { ...base, command: 'DELETE_DRESS_CODE' as const, dressCodeId: dress };
    const replay = mock({
      row: { ...access, plan_version: 9 },
      receipt: {
        operation_type: 'DELETE_DRESS_CODE',
        actor_user_id: actor,
        trip_id: trip,
        request_hash: dressCodeRequestHash(command),
        state: 'SUCCEEDED',
        outcome: result,
      },
    });
    expect(await replay.service.deleteDressCode({ ...base, dressCodeId: dress })).toEqual(result);
    expect(wrote(replay.query)).toBe(false);
  });
});

describe('Dress code Gateway contract', () => {
  const root = `/api/v1/trips/${trip}/dress-codes`;
  it('routes API050-053 and rejects other methods or malformed ids', () => {
    expect(planRoute('GET', root)).toEqual({ kind: 'dress-list', tripId: trip });
    expect(planRoute('POST', root)).toEqual({ kind: 'dress-create', tripId: trip });
    expect(planRoute('PATCH', `${root}/${dress.toUpperCase()}`)).toEqual({
      kind: 'dress-update',
      tripId: trip,
      dressCodeId: dress,
    });
    expect(planRoute('DELETE', `${root}/${dress}`)).toMatchObject({ kind: 'dress-delete' });
    expect(planRoute('PUT', root)).toBeNull();
    expect(planRoute('POST', `${root}/${dress}`)).toBeNull();
    expect(() => planRoute('PATCH', `${root}/not-a-uuid`)).toThrow();
  });
  it('maps create bodies, treating null as omission', () => {
    expect(
      dressCodeRequest(
        { kind: 'dress-create', tripId: trip },
        {
          expected_plan_version: 4,
          scope_type: 'ACTIVITY',
          plan_date: null,
          activity_id: activity.toUpperCase(),
          label: ' Formal ',
          description: null,
          public_description: 'Smart casual',
        },
        actor,
        operation,
      ),
    ).toEqual({
      operation_id: operation,
      actor_user_id: actor,
      trip_id: trip,
      expected_plan_version: 4,
      scope_type: 3,
      label: 'Formal',
      activity_id: activity,
      public_description: 'Smart casual',
    });
  });
  it('maps PATCH nulls to explicit clears and DELETE to a version-only command', () => {
    const route = { kind: 'dress-update' as const, tripId: trip, dressCodeId: dress };
    expect(
      dressCodeRequest(
        route,
        { expected_plan_version: 4, scope_type: 'TRIP', plan_date: null, description: 'Light' },
        actor,
        operation,
      ),
    ).toMatchObject({
      dress_code_id: dress,
      scope_type: 1,
      plan_date: { clear: true },
      description: { value: 'Light' },
    });
    expect(
      dressCodeRequest(
        { ...route, kind: 'dress-delete' },
        { expected_plan_version: 4 },
        actor,
        operation,
      ),
    ).toEqual({
      operation_id: operation,
      actor_user_id: actor,
      trip_id: trip,
      expected_plan_version: 4,
      dress_code_id: dress,
    });
  });
  it.each([
    { expected_plan_version: 4 },
    { expected_plan_version: 0, label: 'x' },
    { expected_plan_version: 4, label: '' },
    { expected_plan_version: 4, scope_type: 'WEEK' },
    { expected_plan_version: 4, plan_date: '02/10/2026' },
    { expected_plan_version: 4, activity_id: 'bad' },
    { expected_plan_version: 4, description: 'x'.repeat(10_001) },
    { expected_plan_version: 4, label: 'x', source: 'DSS' },
  ])('rejects invalid PATCH body %j', (body) => {
    expect(() =>
      dressCodeRequest(
        { kind: 'dress-update', tripId: trip, dressCodeId: dress },
        body,
        actor,
        operation,
      ),
    ).toThrow();
  });
  it('rejects extra fields on DELETE and advertises the write capability on the Plan', () => {
    expect(() =>
      dressCodeRequest(
        { kind: 'dress-delete', tripId: trip, dressCodeId: dress },
        { expected_plan_version: 4, confirmed: true },
        actor,
        operation,
      ),
    ).toThrow();
    expect(
      projectPlan({ trip_id: trip, plan_version: 4, export_revision: 7, permissions: {} })
        .capabilities,
    ).toEqual({ dress_codes_write: true, packing_write: true, locations_write: true });
  });
});
