import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ContributionRepository } = require('../../dist/repositories/contribution.repository.js');

/** Called only by the isolated DB runner. All fixture rows are rolled back. */
export async function checkContributionRepository(client) {
  const repository = new ContributionRepository({ query: client.query.bind(client) });
  const fundId = randomUUID();
  const otherFundId = randomUUID();
  const requestId = randomUUID();
  const secondRequestId = randomUUID();
  const otherRequestId = randomUUID();
  const memberId = randomUUID();
  const contributionId = randomUUID();
  const scope = { fundId, requestId, contributionId };
  const time = new Date('2026-09-30T10:00:00Z');

  await client.query('BEGIN');
  try {
    for (const id of [fundId, otherFundId]) {
      await client.query(
        'INSERT INTO public.funds(id, trip_id, holder_user_id) VALUES ($1, $2, $3)',
        [id, randomUUID(), memberId],
      );
    }
    for (const [id, ownerFundId] of [
      [requestId, fundId],
      [secondRequestId, fundId],
      [otherRequestId, otherFundId],
    ]) {
      await client.query(
        `INSERT INTO public.contribution_requests(id, fund_id, title, created_by_user_id)
         VALUES ($1, $2, 'Reader fixture', $3)`,
        [id, ownerFundId, memberId],
      );
    }
    const request = await repository.findRequestById(scope);
    assert.equal(request.amountPerMember, null);
    assert.equal(request.dueAt, null);
    assert.equal(request.note, null);
    assert.equal(request.closedAt, null);
    assert.equal(request.status, 'OPEN');
    assert.equal(request.version, 1);
    assert(request.createdAt instanceof Date);
    assert.equal(await repository.findRequestById({ fundId: otherFundId, requestId }), null);
    assert.equal(await repository.findRequestById({ fundId, requestId: randomUUID() }), null);
    assert.equal(await repository.findById(scope), null);

    await client.query(
      `INSERT INTO public.contributions(id, request_id, fund_id, member_user_id, amount,
         destination_snapshot, destination_version, transfer_evidence_object_key, self_contribution)
       VALUES ($1, $2, $3, $4, 9007199254740993, $5::jsonb, 1, 'fixture/private-evidence', true)`,
      [
        contributionId,
        requestId,
        fundId,
        memberId,
        JSON.stringify({ account_number: 'fixture-private' }),
      ],
    );
    const contribution = await repository.findById(scope);
    assert.equal(contribution.amount, 9007199254740993n);
    assert.equal(contribution.fundId, fundId);
    assert.equal(contribution.requestId, requestId);
    assert.equal(contribution.memberUserId, memberId);
    assert.equal(contribution.selfContribution, true);
    assert.equal(contribution.memberReportedAt, null);
    assert.equal(contribution.confirmedByUserId, null);
    assert.equal(contribution.confirmedAt, null);
    assert.equal(contribution.version, 1);
    assert(contribution.createdAt instanceof Date);
    assert(contribution.updatedAt instanceof Date);
    assert(!('destinationSnapshot' in contribution));
    assert(!('destination_snapshot' in contribution));
    assert(!('transferEvidenceObjectKey' in contribution));
    assert(!('transfer_evidence_object_key' in contribution));
    assert.equal(await repository.findById({ ...scope, fundId: otherFundId }), null);
    assert.equal(await repository.findById({ ...scope, requestId: secondRequestId }), null);
    assert.equal(
      await repository.findById({ ...scope, fundId: otherFundId, requestId: otherRequestId }),
      null,
    );
    assert.equal(await repository.findById({ ...scope, contributionId: randomUUID() }), null);

    // These are fixture states to exercise reads, not lifecycle commands.
    for (const status of [
      'PENDING',
      'TRANSFER_REPORTED',
      'CONFIRMED',
      'WAIVED',
      'CANCELLED',
      'REVERSED',
    ]) {
      await client.query('UPDATE public.contributions SET status=$2 WHERE id=$1', [
        contributionId,
        status,
      ]);
      assert.equal((await repository.findById(scope)).status, status);
    }
    await client.query(
      `UPDATE public.contributions SET amount=9223372036854775807, version=4,
         member_reported_at=$2, confirmed_at=$2, confirmed_by_user_id=$3, reversed_at=$2,
         rejected_reason='Previous report rejected' WHERE id=$1`,
      [contributionId, time, memberId],
    );
    const historical = await repository.findById(scope);
    assert.equal(historical.amount, 9223372036854775807n);
    assert.equal(historical.version, 4);
    assert.deepEqual(historical.memberReportedAt, time);
    assert.deepEqual(historical.confirmedAt, time);
    assert.deepEqual(historical.reversedAt, time);
    assert.equal(historical.confirmedByUserId, memberId);
    assert.equal(historical.rejectedReason, 'Previous report rejected');

    await client.query(
      `UPDATE public.contribution_requests SET amount_per_member=9223372036854775807,
         due_at=$2, note='Final request', status='CLOSED', closed_at=$2, version=2 WHERE id=$1`,
      [requestId, time],
    );
    assert.deepEqual(await repository.findRequestById(scope), {
      ...request,
      amountPerMember: 9223372036854775807n,
      dueAt: time,
      note: 'Final request',
      status: 'CLOSED',
      closedAt: time,
      version: 2,
    });
    await client.query("UPDATE public.funds SET status='CLOSED', closed_at=$2 WHERE id=$1", [
      fundId,
      time,
    ]);
    assert.deepEqual(await repository.findById(scope), historical);
    await client.query("UPDATE public.contribution_requests SET status='CANCELLED' WHERE id=$1", [
      requestId,
    ]);
    assert.equal((await repository.findRequestById(scope)).status, 'CANCELLED');

    // Collection summaries are reads of fixture states, not payment/lifecycle commands.
    const summaryScope = { fundId, requestId: secondRequestId };
    const empty = await repository.findRequestCollectionSummary(summaryScope);
    assert.equal(empty.requestStatus, 'OPEN');
    assert.equal(empty.requestVersion, 1);
    assert.deepEqual(empty.total, { count: 0n, amount: 0n });
    assert.equal(Object.keys(empty.byStatus).length, 6);
    for (const bucket of Object.values(empty.byStatus)) {
      assert.deepEqual(bucket, { count: 0n, amount: 0n });
    }
    assert.equal(
      await repository.findRequestCollectionSummary({ ...summaryScope, fundId: otherFundId }),
      null,
    );
    assert.equal(
      await repository.findRequestCollectionSummary({ fundId, requestId: randomUUID() }),
      null,
    );
    const allocations = [
      ['PENDING', 100000n],
      ['TRANSFER_REPORTED', 200000n],
      ['CONFIRMED', 350000n],
      ['WAIVED', 40000n],
      ['CANCELLED', 50000n],
      ['REVERSED', 600000n],
    ];
    let reportedId;
    const insertAllocation = async (targetScope, amount, status) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO public.contributions(id, request_id, fund_id, member_user_id,
           amount, status, destination_snapshot, destination_version)
         VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,1)`,
        [id, targetScope.requestId, targetScope.fundId, randomUUID(), amount.toString(), status],
      );
      return id;
    };
    for (const [status, amount] of allocations) {
      const id = await insertAllocation(summaryScope, amount, status);
      if (status === 'TRANSFER_REPORTED') reportedId = id;
    }
    await insertAllocation(
      { fundId: otherFundId, requestId: otherRequestId },
      777000n,
      'CONFIRMED',
    );
    const summary = await repository.findRequestCollectionSummary(summaryScope);
    assert.deepEqual(summary, {
      fundId,
      requestId: secondRequestId,
      requestStatus: 'OPEN',
      requestVersion: 1,
      total: { count: 6n, amount: 1340000n },
      byStatus: Object.fromEntries(
        allocations.map(([status, amount]) => [status, { count: 1n, amount }]),
      ),
    });
    // The original request in this same Fund has an int8-max REVERSED row;
    // neither it nor the other Fund's allocation leaks into this request.
    const originalSummary = await repository.findRequestCollectionSummary(scope);
    assert.equal(originalSummary.requestStatus, 'CANCELLED');
    assert.deepEqual(originalSummary.total, { count: 1n, amount: 9223372036854775807n });
    assert.deepEqual(originalSummary.byStatus.REVERSED, originalSummary.total);
    assert.deepEqual(originalSummary.byStatus.CONFIRMED, { count: 0n, amount: 0n });

    await client.query("UPDATE public.contributions SET status='CONFIRMED' WHERE id=$1", [
      reportedId,
    ]);
    const afterConfirmation = await repository.findRequestCollectionSummary(summaryScope);
    assert.deepEqual(afterConfirmation.total, summary.total);
    assert.deepEqual(afterConfirmation.byStatus.TRANSFER_REPORTED, { count: 0n, amount: 0n });
    assert.deepEqual(afterConfirmation.byStatus.CONFIRMED, { count: 2n, amount: 550000n });

    for (let index = 0; index < 2; index++) {
      await insertAllocation(summaryScope, 9223372036854775807n, 'PENDING');
    }
    const large = await repository.findRequestCollectionSummary(summaryScope);
    assert.deepEqual(large.total, { count: 8n, amount: 18446744073710891614n });
    assert.deepEqual(large.byStatus.PENDING, { count: 3n, amount: 18446744073709651614n });
    for (const status of ['CLOSED', 'CANCELLED']) {
      await client.query(
        'UPDATE public.contribution_requests SET status=$2, version=3 WHERE id=$1',
        [secondRequestId, status],
      );
      assert.deepEqual(await repository.findRequestCollectionSummary(summaryScope), {
        ...large,
        requestStatus: status,
        requestVersion: 3,
      });
    }
  } finally {
    await client.query('ROLLBACK');
  }
  const {
    rows: [remaining],
  } = await client.query(
    `SELECT (SELECT count(*) FROM public.funds WHERE id IN ($1,$2))::int AS funds,
            (SELECT count(*) FROM public.contributions WHERE id=$3)::int AS contributions`,
    [fundId, otherFundId, contributionId],
  );
  assert.deepEqual(remaining, { funds: 0, contributions: 0 });
}
