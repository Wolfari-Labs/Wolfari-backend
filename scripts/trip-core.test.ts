import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { createHash } from 'node:crypto';
import {
  lifecycleAt,
  parseCursor,
  TripError,
  TripService,
} from '../apps/trip-workspace-service/src/trip.service';

const actorId = '10000000-0000-4000-8000-000000000001';
const operationId = '20000000-0000-4000-8000-000000000001';
const tripId = '30000000-0000-4000-8000-000000000001';
const correlationId = '40000000-0000-4000-8000-000000000001';

function service() {
  const database = {
    withTransaction: vi.fn(),
    query: vi.fn(),
  } as unknown as DatabaseProvider;
  return { database, trips: new TripService(database) };
}

describe('Trip core validation', () => {
  it.each([
    ['blank name', { name: '   ' }],
    ['name over 200 characters', { name: 'x'.repeat(201) }],
    ['invalid timezone', { timezone: 'Mars/Olympus' }],
    ['reversed range', { startAt: '2026-10-02T00:00:00Z', endAt: '2026-10-01T00:00:00Z' }],
    ['timestamp without offset', { startAt: '2026-10-01T00:00:00' }],
    ['invalid calendar date', { startAt: '2026-02-30T00:00:00Z' }],
    ['invalid actor UUID', { actorUserId: 'not-a-uuid' }],
  ])('rejects %s before opening a transaction', async (_name, override) => {
    const { database, trips } = service();
    await expect(
      trips.create({
        actorUserId: actorId,
        operationId,
        name: 'Da Nang',
        startAt: '2026-10-01T00:00:00+07:00',
        endAt: '2026-10-02T00:00:00+07:00',
        timezone: 'Asia/Ho_Chi_Minh',
        correlationId,
        ...override,
      }),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'VALIDATION_FAILED', status: 400 });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects unknown PATCH fields and missing metadata before opening a transaction', async () => {
    const { database, trips } = service();
    await expect(
      trips.update({
        actorUserId: actorId,
        operationId,
        tripId,
        expectedPlanVersion: 1,
        expectedExportRevision: 1,
        fields: { timezone: 'UTC' },
        correlationId,
      }),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'VALIDATION_FAILED', status: 400 });
    await expect(
      trips.update({
        actorUserId: actorId,
        operationId,
        tripId,
        expectedPlanVersion: 1,
        expectedExportRevision: 1,
        fields: {},
        correlationId,
      }),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'VALIDATION_FAILED', status: 400 });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['zero plan revision', { expectedPlanVersion: 0 }],
    ['fractional plan revision', { expectedPlanVersion: 1.5 }],
    ['oversized export revision', { expectedExportRevision: 2_147_483_648 }],
    ['string export revision', { expectedExportRevision: '1' }],
  ])('rejects %s before opening a transaction', async (_name, override) => {
    const { database, trips } = service();
    await expect(
      trips.update({
        actorUserId: actorId,
        operationId,
        tripId,
        expectedPlanVersion: 1,
        expectedExportRevision: 1,
        fields: { name: 'Updated' },
        correlationId,
        ...override,
      }),
    ).rejects.toMatchObject<Partial<TripError>>({ code: 'VALIDATION_FAILED', status: 400 });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

describe('Trip lifecycle and cursor', () => {
  const now = new Date('2026-10-02T00:00:00.000Z');

  it('uses exact time boundaries and lets archive override time-derived lifecycle', () => {
    expect(
      lifecycleAt(
        {
          start_at: '2026-10-02T00:00:00.000Z',
          end_at: '2026-10-03T00:00:00.000Z',
          archived_at: null,
        },
        now,
      ),
    ).toBe('ONGOING');
    expect(
      lifecycleAt(
        {
          start_at: '2026-10-01T00:00:00.000Z',
          end_at: '2026-10-02T00:00:00.000Z',
          archived_at: null,
        },
        now,
      ),
    ).toBe('COMPLETED');
    expect(
      lifecycleAt(
        {
          start_at: '2026-10-03T00:00:00.000Z',
          end_at: '2026-10-04T00:00:00.000Z',
          archived_at: '2026-10-01T00:00:00.000Z',
        },
        now,
      ),
    ).toBe('ARCHIVED');
  });

  it('accepts only a cursor bound to the same actor and lifecycle filter', () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        actor_user_id: actorId,
        lifecycle: 'ARCHIVED',
        created_at: '2026-10-01T00:00:00.000Z',
        id: tripId,
      }),
    ).toString('base64url');

    expect(parseCursor(cursor, actorId, 'ARCHIVED')).toEqual({
      createdAt: '2026-10-01T00:00:00.000Z',
      id: tripId,
    });
    expect(() => parseCursor(cursor, operationId, 'ARCHIVED')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => parseCursor(cursor, actorId, null)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => parseCursor(`${cursor}!`, actorId, 'ARCHIVED')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('Trip update replay', () => {
  it('locks membership and returns the current projection after verifying the receipt', async () => {
    const currentMembershipId = '50000000-0000-4000-8000-000000000001';
    const currentRow = {
      id: tripId,
      name: 'Current name',
      description: 'Current description',
      start_at: '2026-10-01T00:00:00.000Z',
      end_at: '2026-10-02T00:00:00.000Z',
      timezone: 'Asia/Ho_Chi_Minh',
      plan_edit_policy: 'OWNER_ONLY',
      plan_version: 2,
      membership_revision: 3,
      export_revision: 4,
      archived_at: '2026-10-03T00:00:00.000Z',
      created_at: '2026-09-01T00:00:00.000Z',
      public_description: 'Current public description',
      membership_id: currentMembershipId,
      membership_user_id: actorId,
      membership_role: 'OWNER',
      membership_joined_at: '2026-09-15T00:00:00.000Z',
      membership_left_at: null,
    } as const;
    const fields = { name: 'Original update' };
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          actor_user_id: actorId,
          command: 'UPDATE_TRIP_METADATA',
          trip_id: tripId,
          payload: {
            expected_plan_version: 1,
            expected_export_revision: 1,
            fields,
          },
        }),
      )
      .digest('hex');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [currentRow] })
      .mockResolvedValueOnce({
        rows: [
          {
            operation_id: operationId,
            trip_id: tripId,
            operation_type: 'UPDATE_TRIP_METADATA',
            actor_user_id: actorId,
            request_hash: requestHash,
            state: 'SUCCEEDED',
            outcome: {
              id: tripId,
              export_revision: 2,
              current_membership: { id: '60000000-0000-4000-8000-000000000001' },
              permissions: ['TRIP_VIEW', 'TRIP_UPDATE_METADATA'],
            },
          },
        ],
      });
    const database = {
      withTransaction: vi.fn(async (work: Parameters<DatabaseProvider['withTransaction']>[0]) =>
        work({ query } as never),
      ),
      query: vi.fn(),
    } as unknown as DatabaseProvider;

    const result = await new TripService(database).update({
      actorUserId: actorId,
      operationId,
      tripId,
      expectedPlanVersion: 1,
      expectedExportRevision: 1,
      fields,
      correlationId,
    });

    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE OF t,m');
    expect(query).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      id: tripId,
      name: 'Current name',
      lifecycle: 'ARCHIVED',
      plan_version: 2,
      membership_revision: 3,
      export_revision: 4,
      current_membership: { id: currentMembershipId },
      permissions: ['TRIP_VIEW'],
    });
  });
});
