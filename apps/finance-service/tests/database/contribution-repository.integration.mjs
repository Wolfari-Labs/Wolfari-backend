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
