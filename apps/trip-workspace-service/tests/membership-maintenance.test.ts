import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { MembershipRepository } from '../src/membership/membership.repository';
import { operationView, type LifecycleRow } from '../src/membership/membership.domain';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tripId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(state: LifecycleRow['state'] = 'NEEDS_REVIEW', operationType = 'LEAVE_MEMBER') {
  const saved = {
    operation_id: operationId,
    trip_id: tripId,
    operation_type: operationType,
    state,
    retry_count: 5,
    next_retry_at: null,
    outcome: null,
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('SELECT * FROM trip_operations')) return { rows: [saved] };
    if (sql.startsWith('SELECT * FROM trips')) return { rows: [{ id: tripId }] };
    if (sql.startsWith('UPDATE trip_operations')) {
      expect(values).toEqual([operationId]);
      return { rows: [{ ...saved, state: 'PENDING_RECOVERY', retry_count: 0 }] };
    }
    return { rows: [] };
  });
  const withTransaction = vi.fn(async (work: (client: { query: typeof query }) => unknown) =>
    work({ query }),
  );
  const repo = new MembershipRepository({ query, withTransaction } as unknown as DatabaseProvider);
  return { repo, query, withTransaction, saved };
}

describe('lifecycle operator maintenance without a runtime worker', () => {
  it('keeps dry-run read-only and projects only the minimal operation', async () => {
    const { repo, query, saved } = fixture();
    const row = await repo.retryNeedsReview(operationId, false);
    expect(row).toBe(saved);
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.map(([sql]) => sql).some((sql) => /UPDATE|INSERT|DELETE/.test(sql)),
    ).toBe(false);
    expect(operationView(row)).toMatchObject({
      operation_id: operationId,
      trip_id: tripId,
      state: 5,
    });
    expect(operationView(row)).not.toHaveProperty('retry_count');
  });

  it('schedules the same normalized ID after operation, Trip and membership locks', async () => {
    const { repo, query, withTransaction } = fixture();
    const row = await repo.retryNeedsReview(operationId.toUpperCase(), true);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      operation_id: operationId,
      state: 'PENDING_RECOVERY',
      retry_count: 0,
    });
    expect(query.mock.calls[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [operationId],
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([operationId]);
    expect(query.mock.calls[2]?.[0]).toContain('FROM trips WHERE id=$1 FOR UPDATE');
    expect(query.mock.calls[3]?.[0]).toContain(
      'FROM trip_members WHERE trip_id=$1 ORDER BY id FOR UPDATE',
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain("state='PENDING_RECOVERY',retry_count=0");
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(1);
  });

  it.each(['SUCCEEDED', 'FAILED', 'PROCESSING', 'PENDING_RECOVERY'] as const)(
    'does not schedule an operation in %s',
    async (state) => {
      const { repo, query } = fixture(state);
      await expect(repo.retryNeedsReview(operationId, true)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
      });
      expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    },
  );

  it('does not expose other operation types', async () => {
    const { repo, query } = fixture('NEEDS_REVIEW', 'CREATE_TRIP');
    await expect(repo.retryNeedsReview(operationId, false)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid operation ID before acquiring a connection', async () => {
    const { repo, withTransaction } = fixture();
    await expect(repo.retryNeedsReview('invalid', true)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
