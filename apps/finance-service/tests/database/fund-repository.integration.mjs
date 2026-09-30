import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FundRepository } = require('../../dist/repositories/fund.repository.js');

/** Called only by the isolated database test runner, after Finance V001. */
export async function checkFundRepository(client) {
  const tripId = randomUUID();
  const otherTripId = randomUUID();
  const holderId = randomUUID();
  const closedAt = new Date('2026-09-30T00:00:00.000Z');
  // Bind reads to the same client so test rows remain inside a rolled-back transaction.
  const repository = new FundRepository({ query: client.query.bind(client) });

  await client.query('BEGIN');
  try {
    const {
      rows: [stored],
    } = await client.query(
      `INSERT INTO public.funds (trip_id, holder_user_id, budget_amount, current_balance)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at, updated_at`,
      [tripId, holderId, '9223372036854775807', '9007199254740993'],
    );
    await client.query(
      `INSERT INTO public.funds (trip_id, holder_user_id, status, closed_at)
       VALUES ($1, $2, 'CLOSED', $3)`,
      [otherTripId, holderId, closedAt],
    );

    assert.deepEqual(await repository.findByTripId(tripId), {
      id: stored.id,
      tripId,
      holderUserId: holderId,
      currency: 'VND',
      budgetAmount: 9223372036854775807n,
      currentBalance: 9007199254740993n,
      status: 'OPEN',
      financeVersion: 1,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
      closedAt: null,
    });
    assert(stored.created_at instanceof Date);

    const other = await repository.findByTripId(otherTripId);
    assert.equal(other.tripId, otherTripId);
    assert.equal(other.budgetAmount, null);
    assert.equal(other.currentBalance, 0n);
    assert.equal(other.status, 'CLOSED');
    assert.deepEqual(other.closedAt, closedAt);
    assert.equal(await repository.findByTripId(randomUUID()), null);

    await client.query('UPDATE public.funds SET budget_amount=0 WHERE trip_id=$1', [tripId]);
    assert.equal((await repository.findByTripId(tripId)).budgetAmount, 0n);
  } finally {
    await client.query('ROLLBACK');
  }

  const {
    rows: [remaining],
  } = await client.query('SELECT count(*)::int AS n FROM public.funds WHERE trip_id IN ($1, $2)', [
    tripId,
    otherTripId,
  ]);
  assert.equal(remaining.n, 0);
}
