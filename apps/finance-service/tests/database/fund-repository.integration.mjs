import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FundRepository } = require('../../dist/repositories/fund.repository.js');

/** Called only by the isolated database test runner, after Finance V001. */
export async function checkFundRepository(client) {
  const tripId = randomUUID();
  const otherTripId = randomUUID();
  const reservedTripId = randomUUID();
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

    assert.equal(await repository.findSummaryByTripId(randomUUID()), null);
    assert.deepEqual(await repository.findSummaryByTripId(otherTripId), {
      ...other,
      reservedRefund: 0n,
      availableBalance: 0n,
    });
    const emptySummary = await repository.findSummaryByTripId(tripId);
    assert.equal(emptySummary.budgetAmount, 0n);
    assert.equal(emptySummary.reservedRefund, 0n);
    assert.equal(emptySummary.availableBalance, 9007199254740993n);

    const addRefund = async (fundId, amount, status) =>
      client.query(
        `INSERT INTO public.fund_refunds
         (fund_id, member_user_id, amount, status, reason, requested_by_user_id)
       VALUES ($1, $2, $3, $4, 'summary test fixture', $2) RETURNING id`,
        [fundId, holderId, amount, status],
      );
    const {
      rows: [pending],
    } = await addRefund(stored.id, '9007199254740990', 'PENDING');
    const {
      rows: [reported],
    } = await addRefund(stored.id, '2', 'HOLDER_REPORTED');
    // Terminal amounts must never be subtracted from the already updated balance again.
    for (const status of ['CONFIRMED', 'CANCELLED', 'REVERSED']) {
      await addRefund(stored.id, '9223372036854775807', status);
    }
    // A different Fund's reservation must not affect this summary.
    const {
      rows: [reservedFund],
    } = await client.query(
      'INSERT INTO public.funds (trip_id, holder_user_id, current_balance) VALUES ($1, $2, 7) RETURNING id',
      [reservedTripId, holderId],
    );
    await addRefund(reservedFund.id, '7', 'PENDING');
    assert.equal((await repository.findSummaryByTripId(reservedTripId)).availableBalance, 0n);
    const summary = await repository.findSummaryByTripId(tripId);
    assert.deepEqual(summary, {
      ...emptySummary,
      reservedRefund: 9007199254740992n,
      availableBalance: 1n,
    });

    await client.query('UPDATE public.fund_refunds SET amount=3 WHERE id=$1', [reported.id]);
    assert.equal((await repository.findSummaryByTripId(tripId)).availableBalance, 0n);
    await client.query('UPDATE public.fund_refunds SET amount=4 WHERE id=$1', [reported.id]);
    await assert.rejects(repository.findSummaryByTripId(tripId), RangeError);
    // SUM(bigint) can exceed int8: keep it exact and reject it, never round or wrap.
    await client.query('UPDATE public.fund_refunds SET amount=9223372036854775807 WHERE id=$1', [
      pending.id,
    ]);
    await assert.rejects(repository.findSummaryByTripId(tripId), RangeError);

    await client.query(
      "UPDATE public.fund_refunds SET status='CANCELLED' WHERE fund_id=$1 AND status IN ('PENDING','HOLDER_REPORTED')",
      [stored.id],
    );
    assert.equal((await repository.findSummaryByTripId(tripId)).reservedRefund, 0n);
  } finally {
    await client.query('ROLLBACK');
  }

  const {
    rows: [remaining],
  } = await client.query(
    'SELECT count(*)::int AS n FROM public.funds WHERE trip_id IN ($1, $2, $3)',
    [tripId, otherTripId, reservedTripId],
  );
  assert.equal(remaining.n, 0);
}
