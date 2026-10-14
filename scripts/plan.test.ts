import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import {
  PlanService,
  isPlanEditor,
  normalizeActivityFields,
  orderedIds,
  planRequestHash,
  validatePermutation,
  validateTimes,
} from '../apps/trip-workspace-service/src/planning/plan.service';
import { insertPlanUpdated } from '../apps/trip-workspace-service/src/planning/plan.events';
import { timestampPatch } from '../apps/trip-workspace-service/src/planning/plan.grpc';
import {
  projectLocation,
  projectPackingItem,
  projectDressCode,
  type AccessRow,
} from '../apps/trip-workspace-service/src/planning/plan.projection';
import type { QueryClient } from '../apps/trip-workspace-service/src/trip-common';
const actor = '10000000-0000-4000-8000-00000000000a';
const trip = '20000000-0000-4000-8000-00000000000b';
const activity = '30000000-0000-4000-8000-00000000000c';
const operation = '40000000-0000-4000-8000-00000000000d';
const base = {
  actorUserId: actor,
  tripId: trip,
  operationId: operation,
  correlationId: operation,
  expectedPlanVersion: 4,
};
const fields = { title: 'Walk', activity_type: 'OTHER', position: 0 };
const access: AccessRow = {
  id: trip,
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
function mock(row = access, receipt?: unknown, activityRow?: unknown) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM trips t JOIN trip_members')) return { rows: row ? [row] : [] };
    if (sql.includes('FROM trip_operations')) return { rows: receipt ? [receipt] : [] };
    if (sql.includes('FROM activities') && sql.includes('FOR UPDATE'))
      return { rows: activityRow ? [activityRow] : [] };
    return { rows: [] };
  });
  const db = {
    withTransaction: vi.fn(async (work: (client: unknown) => unknown) => work({ query })),
  };
  return { service: new PlanService(db as unknown as DatabaseProvider), db, query };
}
describe('Planning validation', () => {
  it.each([
    { title: '' },
    { title: 'x'.repeat(256) },
    { activity_type: 'x'.repeat(41) },
    { position: -1 },
    { position: 0.5 },
    { position: 2147483648 },
    { starts_at: '2026-10-01T00:00:00Z' },
    { starts_at: '2026-10-02T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' },
    { selected_location_id: 'bad' },
    { status: 'COMPLETED' },
  ])('rejects invalid creation before BEGIN: %j', async (override) => {
    const { service, db } = mock();
    await expect(
      service.createActivity({ ...base, fields: { ...fields, ...override } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
  it.each([0, 2147483648, 1.1, '4'])('rejects invalid version %s', async (expectedPlanVersion) => {
    const { service, db } = mock();
    await expect(
      service.createActivity({ ...base, expectedPlanVersion, fields }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
  it('rejects empty PATCH, status PATCH, duplicate order, unconfirmed deletion and unknown completion', async () => {
    const { service, db } = mock();
    const commands = [
      service.updateActivity({ ...base, activityId: activity, fields: {} }),
      service.updateActivity({ ...base, activityId: activity, fields: { status: 'TODO' } }),
      service.reorderActivities({ ...base, activityIds: [activity, activity.toUpperCase()] }),
      service.deleteActivity({ ...base, activityId: activity, confirmed: false }),
      service.setActivityCompletion({ ...base, activityId: activity, status: 0 }),
      service.createActivity({ ...base, actorUserId: 'invalid', fields }),
    ];
    await Promise.all(
      commands.map((command) =>
        expect(command).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }),
      ),
    );
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
  it('allows partial time PATCH but validates merged ranges and exact Trip boundaries', () => {
    expect(normalizeActivityFields({ ends_at: access.end_at }, false)).toHaveProperty('ends_at');
    expect(() =>
      validateTimes(String(access.start_at), String(access.end_at), access),
    ).not.toThrow();
    expect(() => validateTimes(null, String(access.end_at), access)).toThrow();
    expect(() => validateTimes('2026-09-30T23:59:59Z', String(access.end_at), access)).toThrow();
    expect(() => validateTimes(String(access.start_at), '2026-10-03T00:00:01Z', access)).toThrow();
    expect(timestampPatch({ value: { seconds: '0' } })).toEqual(new Date(0));
    expect(timestampPatch({ clear: true })).toBeNull();
    expect(() => timestampPatch({ value: {}, clear: true })).toThrow();
    expect(() => timestampPatch({ clear: false })).toThrow();
  });
  it('moves positions and accepts only complete permutations including an empty Plan', () => {
    expect(orderedIds(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(orderedIds(['a', 'b'], 'c', 1)).toEqual(['a', 'c', 'b']);
    expect(() => orderedIds(['a'], 'b', 2)).toThrow();
    expect(() => validatePermutation(['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(() => validatePermutation([], [])).not.toThrow();
    for (const next of [['a'], ['a', 'c'], ['a', 'a']])
      expect(() => validatePermutation(['a', 'b'], next)).toThrow();
  });
  it('normalizes field order, timezone offsets and UUIDs before hashing', () => {
    const first = normalizeActivityFields(
      {
        ...fields,
        selected_location_id: activity.toUpperCase(),
        starts_at: '2026-10-01T07:00:00+07:00',
        ends_at: '2026-10-01T08:00:00+07:00',
      },
      true,
    );
    const second = normalizeActivityFields(
      {
        ends_at: '2026-10-01T01:00:00Z',
        starts_at: '2026-10-01T00:00:00Z',
        selected_location_id: activity,
        ...fields,
      },
      true,
    );
    const normalized = { ...base, command: 'CREATE_ACTIVITY' as const, fields: first };
    expect(planRequestHash(normalized)).toBe(
      planRequestHash({ ...normalized, fields: second, correlationId: actor }),
    );
    expect(planRequestHash(normalized)).not.toBe(
      planRequestHash({ ...normalized, expectedPlanVersion: 5 }),
    );
  });
});
describe('Planning authorization and replay', () => {
  for (const policy of ['OWNER_ONLY', 'ALL_MEMBERS', 'SELECTED_MEMBERS'] as const) {
    for (const role of ['OWNER', 'MEMBER'] as const)
      for (const selected of [false, true]) {
        it(`${policy} / ${role} / selected=${selected}`, () => {
          expect(isPlanEditor(role, policy, selected)).toBe(
            role === 'OWNER' ||
              policy === 'ALL_MEMBERS' ||
              (policy === 'SELECTED_MEMBERS' && selected),
          );
        });
      }
  }
  it('returns the saved outcome even when the current version is newer or archived', async () => {
    const normalized = {
      ...base,
      command: 'UPDATE_ACTIVITY' as const,
      activityId: activity,
      fields: normalizeActivityFields({ title: 'Saved' }, false),
    };
    const outcome = {
      version: { trip_id: trip, plan_version: 5, export_revision: 8 },
      activity: { id: activity, trip_id: trip, title: 'Saved', plan_version: 5 },
    };
    const receipt = {
      operation_type: normalized.command,
      actor_user_id: actor,
      trip_id: trip,
      request_hash: planRequestHash(normalized),
      state: 'SUCCEEDED',
      outcome,
    };
    const { service, query } = mock(
      { ...access, plan_version: 20, archived_at: access.end_at },
      receipt,
    );
    expect(
      await service.updateActivity({ ...base, activityId: activity, fields: { title: 'Saved' } }),
    ).toEqual(outcome);
    expect(query.mock.calls.some(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
  });
  it('does not consult a receipt after editor access has been revoked', async () => {
    const { service, query } = mock({ ...access, role: 'MEMBER' }, {});
    await expect(service.createActivity({ ...base, fields })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(query.mock.calls.some(([sql]) => sql.includes('trip_operations'))).toBe(false);
  });
  it('returns version details and rejects archived writes without mutations', async () => {
    const stale = mock();
    await expect(
      stale.service.createActivity({ ...base, expectedPlanVersion: 3, fields }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { plan_version: 4, export_revision: 7 },
    });
    const archived = mock({ ...access, archived_at: access.end_at });
    await expect(archived.service.createActivity({ ...base, fields })).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    for (const m of [stale, archived])
      expect(m.query.mock.calls.some(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
  });
  it('prevents another ordinary member from reopening a completed activity', async () => {
    const { service } = mock({ ...access, role: 'MEMBER' }, undefined, {
      id: activity,
      trip_id: trip,
      status: 'COMPLETED',
      completed_by_user_id: operation,
    });
    await expect(
      service.setActivityCompletion({ ...base, activityId: activity, status: 'TODO' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
describe('Plan projections and events', () => {
  it('preserves dates and decimals and strips non-whitelisted metadata', () => {
    expect(
      projectLocation(
        {
          metadata: { secret: 'hidden' },
          latitude: '16.123456',
          longitude: '108.123456',
          fetched_at: null,
        } as Parameters<typeof projectLocation>[0],
        4,
      ),
    ).toMatchObject({ metadata: {}, latitude: '16.123456' });
    expect(
      projectPackingItem(
        { quantity: '2.50', due_at: null, completed_at: null } as Parameters<
          typeof projectPackingItem
        >[0],
        4,
      ),
    ).toMatchObject({ quantity: '2.50' });
    expect(
      projectDressCode({ plan_date: '2026-10-01' } as Parameters<typeof projectDressCode>[0], 4),
    ).toMatchObject({ plan_date: '2026-10-01' });
  });
  it.each(['UPSERT', 'DELETE'] as const)(
    'validates the %s event envelope before inserting outbox',
    async (action) => {
      const query = vi.fn(async () => ({ rows: [] }));
      await insertPlanUpdated({ query } as unknown as QueryClient, {
        tripId: trip,
        actorUserId: actor,
        operationId: operation,
        correlationId: operation,
        planVersion: 5,
        changes: [{ type: 'ACTIVITY', id: activity, action }],
      });
      const payload = JSON.parse(
        (query.mock.calls[0] as unknown as [string, unknown[]])[1][5] as string,
      );
      expect(payload.source_version).toBe(5);
      expect(payload.tombstones).toEqual(
        action === 'DELETE' ? [{ type: 'ACTIVITY', id: activity, source_version: 5 }] : [],
      );
    },
  );
});
