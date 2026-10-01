import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LedgerRepository } = require('../../dist/repositories/ledger.repository.js');

/** Isolated database runner only. Fixture setup is not a business write implementation. */
export async function checkLedgerRepository(client) {
  const fundId = randomUUID();
  const otherFundId = randomUUID();
  const actorId = randomUUID();
  const repository = new LedgerRepository({ query: client.query.bind(client) });
  const createdAt = new Date('2026-09-30T00:00:00Z');
  const base = 9007199254740993n;
  const amount = '9007199254740993';

  await client.query('BEGIN');
  try {
    for (const id of [fundId, otherFundId]) {
      await client.query(
        'INSERT INTO public.funds(id, trip_id, holder_user_id) VALUES ($1, $2, $3)',
        [id, randomUUID(), actorId],
      );
    }
    assert.deepEqual(await repository.listByFundId(fundId), { items: [], nextCursor: null });
    assert.deepEqual(await repository.listByFundId(randomUUID()), { items: [], nextCursor: null });

    const addRefundEntry = async (id, sequence) => {
      const {
        rows: [refund],
      } = await client.query(
        `INSERT INTO public.fund_refunds(fund_id, member_user_id, amount, status, reason, requested_by_user_id)
         VALUES ($1, $2, $3, 'CONFIRMED', 'ledger reader fixture', $2) RETURNING id`,
        [id, actorId, amount],
      );
      const {
        rows: [entry],
      } = await client.query(
        `INSERT INTO public.fund_transactions(fund_id, sequence, direction, transaction_type, amount,
           balance_after, refund_id, actor_user_id, business_key, created_at)
         VALUES ($1, $2, 'OUT', 'REFUND', $3, 0, $4, $5, $6, $7) RETURNING id`,
        [id, sequence.toString(), amount, refund.id, actorId, randomUUID(), createdAt],
      );
      return { id: entry.id, refundId: refund.id };
    };
    const original = await addRefundEntry(fundId, base);
    const middle = await addRefundEntry(fundId, base + 2n);
    const {
      rows: [reversal],
    } = await client.query(
      `INSERT INTO public.fund_transactions(fund_id, sequence, direction, transaction_type, amount,
         balance_after, reversal_of_id, reason, business_key, created_at)
       VALUES ($1, $2, 'IN', 'REVERSAL', $3, $3, $4, 'Correction', $5, $6) RETURNING id`,
      [fundId, (base + 5n).toString(), amount, original.id, randomUUID(), createdAt],
    );
    await addRefundEntry(otherFundId, 9223372036854775807n);
    const first = await repository.listByFundId(fundId, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.id),
      [reversal.id, middle.id],
    );
    assert.deepEqual(first.items[0], {
      id: reversal.id,
      fundId,
      sequence: base + 5n,
      direction: 'IN',
      transactionType: 'REVERSAL',
      amount: BigInt(amount),
      balanceAfter: BigInt(amount),
      contributionId: null,
      expenseId: null,
      refundId: null,
      reversalOfId: original.id,
      actorUserId: null,
      reason: 'Correction',
      createdAt,
    });
    assert(first.nextCursor);
    await assert.rejects(
      repository.listByFundId(otherFundId, { cursor: first.nextCursor }),
      TypeError,
    );

    // Simulate a new higher-sequence append between reads. This is fixture-only SQL.
    const newer = await addRefundEntry(fundId, base + 7n);
    // Reader must retain history for CLOSED Funds as well as OPEN Funds.
    await client.query("UPDATE public.funds SET status='CLOSED', closed_at=$2 WHERE id=$1", [
      fundId,
      createdAt,
    ]);
    const second = await repository.listByFundId(fundId, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(
      second.items.map((item) => item.id),
      [original.id],
    );
    assert.equal(second.items[0].sequence, base);
    assert.equal(second.items[0].amount, BigInt(amount));
    assert.equal(second.items[0].balanceAfter, 0n);
    assert.equal(second.items[0].refundId, original.refundId);
    assert.equal(second.items[0].actorUserId, actorId);
    assert.equal(second.nextCursor, null);
    assert.equal((await repository.listByFundId(fundId)).items[0].id, newer.id);
    const exact = await repository.listByFundId(fundId, { limit: 4 });
    assert.equal(exact.items.length, 4);
    assert.equal(exact.nextCursor, null);
    const other = await repository.listByFundId(otherFundId);
    assert.equal(other.items.length, 1);
    assert.equal(other.items[0].sequence, 9223372036854775807n);
  } finally {
    await client.query('ROLLBACK');
  }
  const {
    rows: [remaining],
  } = await client.query('SELECT count(*)::int AS n FROM public.funds WHERE id IN ($1, $2)', [
    fundId,
    otherFundId,
  ]);
  assert.equal(remaining.n, 0);
}
