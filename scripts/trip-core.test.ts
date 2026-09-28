import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
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
    ['invalid timezone', { timezone: 'Mars/Olympus' }],
    ['reversed range', { startAt: '2026-10-02T00:00:00Z', endAt: '2026-10-01T00:00:00Z' }],
    ['timestamp without offset', { startAt: '2026-10-01T00:00:00' }],
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
  });
});
