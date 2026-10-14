import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { editorMemberIds } from '../apps/trip-workspace-service/src/trip-access.domain';
import { TripAccessService } from '../apps/trip-workspace-service/src/trip-access.service';
import { TripError } from '../apps/trip-workspace-service/src/trip.errors';
import { tripGrpcStatus } from '../apps/trip-workspace-service/src/trip.grpc';
import {
  planPolicyRequestHash,
  TripPlanAccessService,
} from '../apps/trip-workspace-service/src/trip-plan-access.service';

const ownerId = '10000000-0000-4000-8000-000000000001';
const memberId = '10000000-0000-4000-8000-000000000002';
const operationId = '20000000-0000-4000-8000-000000000001';
const tripId = '30000000-0000-4000-8000-000000000001';
const membershipId = '40000000-0000-4000-8000-000000000001';
const editorId = '40000000-0000-4000-8000-000000000002';
const secondEditorId = '40000000-0000-4000-8000-000000000003';
const correlationId = '50000000-0000-4000-8000-000000000001';

function accessRow(
  role: 'OWNER' | 'MEMBER',
  policy: 'OWNER_ONLY' | 'SELECTED_MEMBERS' | 'ALL_MEMBERS',
  selectedEditor = false,
  archived = false,
) {
  return {
    trip_id: tripId,
    plan_edit_policy: policy,
    plan_version: 7,
    membership_revision: 3,
    export_revision: 9,
    archived_at: archived ? '2026-09-30T00:00:00.000Z' : null,
    membership_id: role === 'OWNER' ? membershipId : editorId,
    membership_user_id: role === 'OWNER' ? ownerId : memberId,
    membership_role: role,
    membership_joined_at: '2026-09-01T00:00:00.000Z',
    membership_left_at: null,
    selected_editor: selectedEditor,
  };
}

function accessService(row?: ReturnType<typeof accessRow>) {
  const query = vi.fn().mockResolvedValue({ rows: row ? [row] : [] });
  const database = { query } as unknown as DatabaseProvider;
  return { query, service: new TripAccessService(database) };
}

describe('Trip access context', () => {
  it.each([
    ['Owner', 'OWNER', 'OWNER_ONLY', false, false, true],
    ['owner under selected policy', 'OWNER', 'SELECTED_MEMBERS', false, false, true],
    ['ordinary Member', 'MEMBER', 'OWNER_ONLY', false, false, false],
    ['all-members editor', 'MEMBER', 'ALL_MEMBERS', false, false, true],
    ['selected editor', 'MEMBER', 'SELECTED_MEMBERS', true, false, true],
    ['unselected Member', 'MEMBER', 'SELECTED_MEMBERS', false, false, false],
    ['archived Owner', 'OWNER', 'OWNER_ONLY', false, true, false],
  ] as const)(
    'computes PLAN_EDIT for %s',
    async (_name, role, policy, selected, archived, expected) => {
      const { service } = accessService(accessRow(role, policy, selected, archived));
      const context = await service.getContext({ tripId, userId: memberId, action: 'PLAN_EDIT' });
      expect(context.can_edit_plan).toBe(expected);
      expect(context.allowed).toBe(expected);
      expect(context.can_read_trip).toBe(true);
      expect(context.can_update_trip_metadata).toBe(!archived && role === 'OWNER');
    },
  );

  it('returns only the whitelisted projection and locks the same rows for a write check', async () => {
    const row = accessRow('OWNER', 'OWNER_ONLY');
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const database = { query } as unknown as DatabaseProvider;
    const service = new TripAccessService(database);
    const context = await service.getContextForUpdate({ query } as never, {
      tripId,
      userId: ownerId,
      action: 'PLAN_POLICY_UPDATE',
    });
    expect(Object.keys(context).sort()).toEqual(
      [
        'allowed',
        'can_edit_plan',
        'can_read_trip',
        'can_update_trip_metadata',
        'membership',
        'permissions',
        'policy',
        'revisions',
        'trip_id',
        'trip_state',
      ].sort(),
    );
    expect(context).not.toHaveProperty('selected_editor');
    expect(query.mock.calls[0]?.[0]).toContain('FROM trips WHERE id=$1 FOR UPDATE');
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE OF t,m');
    expect(query.mock.calls[0]?.[0]).not.toContain('trip_plan_editors');
    expect(query.mock.calls[2]?.[0]).toContain('FROM trip_plan_editors pe');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('uses the fresh permission snapshot after acquiring the write locks', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: tripId }] })
      .mockResolvedValueOnce({ rows: [{ id: tripId }] })
      .mockResolvedValueOnce({ rows: [accessRow('MEMBER', 'SELECTED_MEMBERS', false)] });
    const service = new TripAccessService({ query } as unknown as DatabaseProvider);
    const context = await service.getContextForUpdate(
      { query },
      {
        tripId,
        userId: memberId,
        action: 'PLAN_EDIT',
      },
    );
    expect(context.can_edit_plan).toBe(false);
    expect(context.allowed).toBe(false);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('stops before reading assignments when the write lock finds no active membership', async () => {
    const { query, service } = accessService();
    await expect(
      service.getContextForUpdate({ query }, { tripId, userId: memberId, action: 'PLAN_EDIT' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    'outsider',
    'departed member',
    'Member from another Trip',
    'Admin without membership',
    'deleted Trip',
  ])('hides the Trip from %s', async () => {
    const { query, service } = accessService();
    await expect(
      service.getContext({ tripId, userId: memberId, action: 'TRIP_VIEW' }),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'RESOURCE_NOT_FOUND' });
    expect(query.mock.calls[0]?.[0]).toContain('m.left_at IS NULL');
    expect(query.mock.calls[0]?.[0]).toContain('t.deleted_at IS NULL');
  });

  it.each([
    ['invalid UUID', { tripId: 'invalid', userId: memberId, action: 'TRIP_VIEW' }],
    ['unknown action', { tripId, userId: memberId, action: 'PLAN_DELETE' }],
  ])('rejects %s before querying', async (_name, input) => {
    const { query, service } = accessService();
    await expect(service.getContext(input)).rejects.toMatchObject<Partial<TripError>>({
      code: 'VALIDATION_FAILED',
    });
    expect(query).not.toHaveBeenCalled();
  });
});

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    trip_id: tripId,
    plan_edit_policy: 'OWNER_ONLY',
    membership_revision: 1,
    archived_at: null,
    membership_id: membershipId,
    membership_role: 'OWNER',
    ...overrides,
  };
}

function updateInput(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    actorUserId: ownerId,
    tripId,
    policy: 'SELECTED_MEMBERS',
    editorMemberIds: [editorId],
    expectedMembershipRevision: 1,
    correlationId,
    ...overrides,
  };
}

describe('Trip Plan policy mutation', () => {
  const replayOutcome = {
    policy: 'SELECTED_MEMBERS',
    editor_member_ids: [editorId],
    membership_revision: 2,
  };

  function replayService(outcome: unknown, actor: Record<string, unknown> = {}) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT t.id AS trip_id')) {
        return {
          rows: [ownerRow({ plan_edit_policy: 'ALL_MEMBERS', membership_revision: 3, ...actor })],
        };
      }
      if (sql.includes('FROM trip_operations WHERE')) {
        return {
          rows: [
            {
              operation_id: operationId,
              trip_id: tripId,
              operation_type: 'UPDATE_PLAN_POLICY',
              actor_user_id: ownerId,
              request_hash: planPolicyRequestHash(
                updateInput() as Parameters<typeof planPolicyRequestHash>[0],
              ),
              state: 'SUCCEEDED',
              outcome,
            },
          ],
        };
      }
      if (sql.includes('trip_plan_editors'))
        throw new Error('Replay must not read current editors');
      return { rows: [] };
    });
    const database = {
      withTransaction: async (work: Parameters<DatabaseProvider['withTransaction']>[0]) =>
        work({ query } as never),
    } as unknown as DatabaseProvider;
    return { query, service: new TripPlanAccessService(database) };
  }

  it.each(['jsonb', 'json string'])(
    'replays the original whitelisted outcome from %s after a later mutation',
    async (format) => {
      const stored = { ...replayOutcome, internal_data: 'must not leak' };
      const { query, service } = replayService(
        format === 'jsonb' ? stored : JSON.stringify(stored),
      );
      expect(await service.updatePolicy(updateInput())).toEqual(replayOutcome);
      expect(query).toHaveBeenCalledTimes(5);
    },
  );

  it.each([
    { ...replayOutcome, policy: 'UNKNOWN' },
    { ...replayOutcome, editor_member_ids: ['invalid'] },
    { ...replayOutcome, editor_member_ids: [editorId, editorId] },
    { ...replayOutcome, membership_revision: 0 },
    { ...replayOutcome, membership_revision: '2' },
  ])(
    'rejects a malformed stored outcome instead of projecting current state: %j',
    async (outcome) => {
      const { service } = replayService(outcome);
      await expect(service.updatePolicy(updateInput())).rejects.toThrow(
        'Invalid operation outcome',
      );
    },
  );

  it('checks current Owner permission before returning a stored replay', async () => {
    const { query, service } = replayService(replayOutcome, { membership_role: 'MEMBER' });
    await expect(service.updatePolicy(updateInput())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['VALIDATION_FAILED', 3], // INVALID_ARGUMENT
    ['RESOURCE_NOT_FOUND', 5], // NOT_FOUND
    ['PERMISSION_DENIED', 7], // PERMISSION_DENIED
    ['VERSION_CONFLICT', 10], // ABORTED
    ['STATE_CONFLICT', 9], // FAILED_PRECONDITION
    ['IDEMPOTENCY_CONFLICT', 6], // ALREADY_EXISTS
  ] as const)('maps %s to the documented gRPC status', (code, expected) => {
    expect(tripGrpcStatus(new TripError(code, 500))).toBe(expected);
  });

  it('normalizes editor IDs before hashing an idempotent command', () => {
    const normalized = editorMemberIds([secondEditorId, editorId]);
    expect(normalized).toEqual([editorId, secondEditorId]);
    const first = planPolicyRequestHash({
      actorUserId: ownerId,
      tripId,
      policy: 'SELECTED_MEMBERS',
      editorMemberIds: normalized,
      expectedMembershipRevision: 1,
    });
    const second = planPolicyRequestHash({
      actorUserId: ownerId,
      tripId,
      policy: 'SELECTED_MEMBERS',
      editorMemberIds: editorMemberIds([editorId, secondEditorId]),
      expectedMembershipRevision: 1,
    });
    expect(first).toBe(second);
  });

  it.each([
    ['unknown policy', { policy: 'OWNER_AND_EDITORS' }],
    ['duplicate editor', { editorMemberIds: [editorId, editorId] }],
    ['non-empty list outside selected policy', { policy: 'ALL_MEMBERS' }],
    ['zero revision', { expectedMembershipRevision: 0 }],
    ['invalid operation UUID', { operationId: 'invalid' }],
  ])('rejects %s before a transaction', async (_name, override) => {
    const database = { withTransaction: vi.fn() } as unknown as DatabaseProvider;
    await expect(
      new TripPlanAccessService(database).updatePolicy(updateInput(override)),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'VALIDATION_FAILED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('records a receipt but no audit or revision change for a no-op', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT t.id AS trip_id')) return { rows: [ownerRow()] };
      if (sql.includes('FROM trip_operations WHERE')) return { rows: [] };
      if (sql.includes('SELECT trip_member_id FROM trip_plan_editors')) {
        return { rows: [{ trip_member_id: editorId }] };
      }
      if (sql.includes('SELECT id FROM trip_members')) return { rows: [{ id: editorId }] };
      if (sql.includes('FROM trip_plan_editors pe')) {
        return { rows: [{ trip_member_id: editorId }] };
      }
      return { rows: [] };
    });
    const database = {
      withTransaction: vi.fn(async (work: Parameters<DatabaseProvider['withTransaction']>[0]) =>
        work({ query } as never),
      ),
    } as unknown as DatabaseProvider;
    const result = await new TripPlanAccessService(database).updatePolicy(
      updateInput({ policy: 'OWNER_ONLY', editorMemberIds: [] }),
    );
    expect(result).toEqual({
      policy: 'OWNER_ONLY',
      editor_member_ids: [editorId],
      membership_revision: 1,
    });
    expect(statements.some((sql) => sql.includes('UPDATE trips SET plan_edit_policy'))).toBe(false);
    expect(statements.some((sql) => sql.includes("'PLAN_ACCESS_UPDATED'"))).toBe(false);
    expect(statements.some((sql) => sql.includes('INSERT INTO trip_operations'))).toBe(true);
  });

  it('replaces selected editors and increments only membership_revision', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT t.id AS trip_id')) return { rows: [ownerRow()] };
      if (sql.includes('FROM trip_operations WHERE')) return { rows: [] };
      if (sql.includes('SELECT trip_member_id FROM trip_plan_editors')) return { rows: [] };
      if (sql.includes('SELECT id FROM trip_members')) return { rows: [{ id: editorId }] };
      if (sql.includes('UPDATE trips SET plan_edit_policy')) {
        expect(sql).toContain('membership_revision=membership_revision+1');
        expect(sql).not.toContain('plan_version');
        expect(sql).not.toContain('export_revision');
        return { rows: [{ membership_revision: 2 }] };
      }
      if (sql.includes('FROM trip_plan_editors pe')) {
        return { rows: [{ trip_member_id: editorId }] };
      }
      return { rows: [] };
    });
    const database = {
      withTransaction: vi.fn(async (work: Parameters<DatabaseProvider['withTransaction']>[0]) =>
        work({ query } as never),
      ),
    } as unknown as DatabaseProvider;
    const result = await new TripPlanAccessService(database).updatePolicy(updateInput());
    expect(result).toEqual({
      policy: 'SELECTED_MEMBERS',
      editor_member_ids: [editorId],
      membership_revision: 2,
    });
    expect(statements.some((sql) => sql.includes('INSERT INTO trip_plan_editors'))).toBe(true);
    expect(statements.some((sql) => sql.includes("'PLAN_ACCESS_UPDATED'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO trip_operations'))).toBe(true);
  });

  it.each([
    ['Member caller', { membership_role: 'MEMBER' }, 'PERMISSION_DENIED'],
    ['archived Trip', { archived_at: '2026-09-30T00:00:00.000Z' }, 'STATE_CONFLICT'],
    ['stale revision', { membership_revision: 2 }, 'VERSION_CONFLICT'],
  ])('rejects %s without applying a change', async (_name, overrides, expectedCode) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT t.id AS trip_id')) return { rows: [ownerRow(overrides)] };
      if (sql.includes('FROM trip_operations WHERE')) return { rows: [] };
      return { rows: [] };
    });
    const database = {
      withTransaction: vi.fn(async (work: Parameters<DatabaseProvider['withTransaction']>[0]) =>
        work({ query } as never),
      ),
    } as unknown as DatabaseProvider;
    await expect(
      new TripPlanAccessService(database).updatePolicy(updateInput()),
    ).rejects.toMatchObject<Partial<TripError>>({ code: expectedCode });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('UPDATE trips SET plan_edit_policy')),
    ).toBe(false);
  });

  it('rejects an outsider, departed Member or Member from another Trip as an editor', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT t.id AS trip_id')) return { rows: [ownerRow()] };
      if (sql.includes('FROM trip_operations WHERE')) return { rows: [] };
      if (sql.includes('SELECT trip_member_id FROM trip_plan_editors')) return { rows: [] };
      if (sql.includes('SELECT id FROM trip_members')) return { rows: [] };
      return { rows: [] };
    });
    const database = {
      withTransaction: vi.fn(async (work: Parameters<DatabaseProvider['withTransaction']>[0]) =>
        work({ query } as never),
      ),
    } as unknown as DatabaseProvider;
    await expect(
      new TripPlanAccessService(database).updatePolicy(updateInput()),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'VALIDATION_FAILED' });
  });
});
