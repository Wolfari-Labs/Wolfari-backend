import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runFinanceLifecycleTests(h, helpers) {
  const { request, query, transaction, bearer, waitFor, pass, restartTrip } = h;
  const { owner, holder, member } = h.actors;
  const { newTrip, write, enableBody, rpc } = helpers;

  const tripRevision = async (tripId) =>
    Number(
      (await query('trip', 'SELECT membership_revision FROM trips WHERE id=$1', [tripId]))[0]
        .membership_revision,
    );
  const addMember = async (tripId, user = member) => {
    const row = (
      await query(
        'trip',
        `INSERT INTO trip_members(trip_id,user_id,role,joined_at)
         VALUES($1,$2,'MEMBER',now()) RETURNING id`,
        [tripId, user.id],
      )
    )[0];
    await query('trip', 'UPDATE trips SET membership_revision=membership_revision+1 WHERE id=$1', [
      tripId,
    ]);
    return row.id;
  };
  const setup = async (withFund = true) => {
    const tripId = await newTrip();
    const membershipId = await addMember(tripId);
    let fundId;
    if (withFund) {
      const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
      assert.equal(enabled.status, 201, JSON.stringify(enabled.body));
      fundId = enabled.body.data.id;
    }
    return { tripId, membershipId, fundId };
  };
  const lifecycle = async ({
    tripId,
    membershipId,
    actor = member,
    remove = false,
    key = randomUUID(),
  }) =>
    request(
      remove ? `/api/v1/trips/${tripId}/members/${membershipId}` : `/api/v1/trips/${tripId}/leave`,
      remove ? 'DELETE' : 'POST',
      {
        reason: remove ? 'Owner removed member' : 'Member left trip',
        expected_membership_revision: await tripRevision(tripId),
      },
      { ...bearer(actor), 'idempotency-key': key },
    );
  const contribution = async (fundId, status = 'PENDING') => {
    const requestId = randomUUID();
    const contributionId = randomUUID();
    await transaction('finance', async (client) => {
      await client.query(
        `INSERT INTO contribution_requests(id,fund_id,title,status,created_by_user_id)
         VALUES($1,$2,$3,'OPEN',$4)`,
        [requestId, fundId, `Lifecycle ${status} ${requestId}`, owner.id],
      );
      await client.query(
        `INSERT INTO contributions
         (id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,
          destination_version,member_reported_at)
         VALUES($1,$2,$3,$4,100000,$5::varchar,$6::jsonb,1,
           CASE WHEN $5::varchar='TRANSFER_REPORTED' THEN now() ELSE NULL END)`,
        [
          contributionId,
          requestId,
          fundId,
          member.id,
          status,
          JSON.stringify({ destination_type: 'VIETQR', reference: requestId }),
        ],
      );
    });
    return contributionId;
  };
  const activeMembership = async (membershipId) =>
    (await query('trip', 'SELECT left_at FROM trip_members WHERE id=$1', [membershipId]))[0]
      .left_at === null;

  const withoutFund = await setup(false);
  assert.equal((await lifecycle(withoutFund)).status, 200);
  assert.equal(await activeMembership(withoutFund.membershipId), false);
  pass('Real Trip and Finance allow leave when the Trip has no Fund');

  const waiver = await setup();
  const waiverIds = [await contribution(waiver.fundId), await contribution(waiver.fundId)];
  const beforeFund = (
    await query('finance', 'SELECT finance_version,current_balance::text FROM funds WHERE id=$1', [
      waiver.fundId,
    ])
  )[0];
  assert.equal((await lifecycle(waiver)).status, 200);
  const waived = await query(
    'finance',
    `SELECT id,status,waived_reason,waived_at,version FROM contributions
     WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [waiverIds],
  );
  assert.equal(waived.length, 2);
  assert(waived.every((row) => row.status === 'WAIVED' && row.waived_reason === 'MEMBER_LEFT'));
  assert(waived.every((row) => row.waived_at && row.version === 2));
  const afterFund = (
    await query('finance', 'SELECT finance_version,current_balance::text FROM funds WHERE id=$1', [
      waiver.fundId,
    ])
  )[0];
  assert.equal(afterFund.finance_version, beforeFund.finance_version + 1);
  assert.equal(afterFund.current_balance, beforeFund.current_balance);
  assert.equal(
    Number(
      (
        await query(
          'finance',
          `SELECT count(*)::int n FROM finance_audit_logs
           WHERE fund_id=$1 AND action='LEAVE_MEMBER' AND reason='MEMBER_LEFT'`,
          [waiver.fundId],
        )
      )[0].n,
    ),
    2,
  );
  const waiverEvents = await query(
    'finance',
    `SELECT aggregate_version,payload FROM outbox_events
     WHERE aggregate_id=$1 AND event_type='ContributionUpdated' ORDER BY event_id`,
    [waiver.fundId],
  );
  assert.equal(waiverEvents.length, 2);
  assert(waiverEvents.every((row) => row.aggregate_version === afterFund.finance_version));
  assert(waiverEvents.every((row) => row.payload.status === 'WAIVED'));
  assert.equal(
    (
      await query('finance', 'SELECT count(*)::int n FROM fund_transactions WHERE fund_id=$1', [
        waiver.fundId,
      ])
    )[0].n,
    0,
  );
  pass('Two eligible PENDING contributions become WAIVED/MEMBER_LEFT with one Fund version');

  const mixed = await setup();
  const pendingId = await contribution(mixed.fundId);
  await contribution(mixed.fundId, 'TRANSFER_REPORTED');
  const mixedResult = await lifecycle(mixed);
  assert.equal(mixedResult.status, 409, JSON.stringify(mixedResult.body));
  assert.equal(mixedResult.body.error.code, 'FINANCE_OBLIGATION_BLOCKED');
  assert.equal(
    (await query('finance', 'SELECT status FROM contributions WHERE id=$1', [pendingId]))[0].status,
    'PENDING',
  );
  assert.equal(await activeMembership(mixed.membershipId), true);
  pass('TRANSFER_REPORTED rejects the whole operation without partially waiving PENDING rows');

  const payment = await setup();
  const paymentContribution = await contribution(payment.fundId);
  const attemptId = randomUUID();
  await query(
    'finance',
    `INSERT INTO payment_attempts
     (id,contribution_id,provider,environment,amount,client_request_id,status,merchant_id,
      provider_order_id,destination_snapshot,needs_reconciliation)
     VALUES($1,$2,'MOMO_SANDBOX','SANDBOX',100000,$3,'PENDING','MOMO_TEST',$4,$5::jsonb,false)`,
    [attemptId, paymentContribution, randomUUID(), `WLF-${attemptId}`, JSON.stringify({})],
  );
  assert.equal(
    (
      await lifecycle({
        ...payment,
        actor: owner,
        remove: true,
      })
    ).status,
    409,
  );
  await query(
    'finance',
    "UPDATE payment_attempts SET status='FAILED',needs_reconciliation=false WHERE id=$1",
    [attemptId],
  );
  assert.equal(
    (
      await lifecycle({
        ...payment,
        actor: owner,
        remove: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await query('finance', 'SELECT status FROM contributions WHERE id=$1', [paymentContribution])
    )[0].status,
    'WAIVED',
  );
  pass('Active Payment blocks remove; resolved FAILED attempt permits the same PENDING waiver');

  const refund = await setup();
  const refundId = randomUUID();
  await query(
    'finance',
    `INSERT INTO fund_refunds(id,fund_id,member_user_id,amount,status,reason,requested_by_user_id)
     VALUES($1,$2,$3,50000,'PENDING','Unused trip balance',$4)`,
    [refundId, refund.fundId, member.id, owner.id],
  );
  assert.equal((await lifecycle(refund)).status, 409);
  await query(
    'finance',
    "UPDATE fund_refunds SET status='CANCELLED',cancelled_at=now(),cancelled_reason='Resolved' WHERE id=$1",
    [refundId],
  );
  assert.equal((await lifecycle(refund)).status, 200);
  pass('Pending Refund blocks leave while CANCELLED Refund remains historical');

  const holderTrip = await newTrip();
  const holderMembership = (
    await query(
      'trip',
      'SELECT id FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
      [holderTrip, holder.id],
    )
  )[0].id;
  const enabled = await write(`/api/v1/trips/${holderTrip}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  assert.equal(
    (
      await lifecycle({
        tripId: holderTrip,
        membershipId: holderMembership,
        actor: owner,
        remove: true,
      })
    ).status,
    409,
  );
  await query('finance', "UPDATE funds SET status='CLOSED',closed_at=now() WHERE id=$1", [
    enabled.body.data.id,
  ]);
  assert.equal(
    (
      await lifecycle({
        tripId: holderTrip,
        membershipId: holderMembership,
        actor: owner,
        remove: true,
      })
    ).status,
    200,
  );
  pass('Fund Holder cannot be removed before CLOSED and can leave after closure');

  const history = await setup();
  const expenseId = randomUUID();
  const noteId = randomUUID();
  await transaction('finance', async (client) => {
    await client.query(
      `INSERT INTO fund_expenses
       (id,fund_id,title,amount,status,created_by_user_id,submitted_at)
       VALUES($1,$2,'Member expense',10000,'SUBMITTED',$3,now())`,
      [expenseId, history.fundId, member.id],
    );
    await client.query(
      `INSERT INTO financial_notes
       (id,fund_id,payer_user_id,amount,description,created_by_user_id)
       VALUES($1,$2,$3,10000,'Historical outside-Fund note',$3)`,
      [noteId, history.fundId, member.id],
    );
  });
  assert.equal((await lifecycle(history)).status, 200);
  assert.equal(
    (
      await query(
        'finance',
        `SELECT
           (SELECT count(*)::int FROM fund_expenses WHERE id=$1) expenses,
           (SELECT count(*)::int FROM financial_notes WHERE id=$2) notes`,
        [expenseId, noteId],
      )
    )[0].expenses,
    1,
  );
  pass('Expense and Financial Note attribution remains historical and does not block departure');

  const closing = await setup();
  await query('finance', "UPDATE funds SET status='CLOSING' WHERE id=$1", [closing.fundId]);
  const direct = await rpc('ExecuteTripOperation', {
    operation_id: randomUUID(),
    request_hash: 'c'.repeat(64),
    operation_type: 'LEAVE_MEMBER',
    authorization_context: {
      actor: { actor_user_id: member.id },
      trip_id: closing.tripId,
      context_revision: await tripRevision(closing.tripId),
      active_user_ids: [owner.id, holder.id, member.id],
      command_scope: 'LEAVE_MEMBER',
    },
    membership_target: {
      membership_id: closing.membershipId,
      user_id: member.id,
      reason: 'Closing blocks leave',
    },
  });
  assert.equal(direct.receipt.outcome.error_code, 'FINANCE_OBLIGATION_BLOCKED');
  assert.deepEqual(direct.receipt.outcome.blocking_ids ?? [], []);
  pass('Finance fails closed for CLOSING without disclosing private blocking IDs');

  const recovery = await setup();
  const recoveryContribution = await contribution(recovery.fundId);
  const recoveryKey = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `finance_lifecycle_trip_fault_${suffix}`;
  await query(
    'trip',
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
       IF NEW.trip_id='${recovery.tripId}'::uuid AND NEW.action='MEMBER_LEFT'
       THEN RAISE EXCEPTION 'test lifecycle Trip failure'; END IF; RETURN NEW; END $$;
     CREATE TRIGGER ${trigger} BEFORE INSERT ON trip_audit_logs
     FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  try {
    const pending = await lifecycle({ ...recovery, key: recoveryKey });
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    assert.equal(
      (
        await query('finance', 'SELECT status FROM contributions WHERE id=$1', [
          recoveryContribution,
        ])
      )[0].status,
      'WAIVED',
    );
    assert.equal(await activeMembership(recovery.membershipId), true);
  } finally {
    await query('trip', `DROP TRIGGER ${trigger} ON trip_audit_logs; DROP FUNCTION ${trigger}()`);
  }
  await query(
    'trip',
    "UPDATE trip_operations SET next_retry_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
    [recoveryKey],
  );
  await restartTrip();
  await waitFor(async () => {
    const row = (
      await query('trip', 'SELECT state FROM trip_operations WHERE operation_id=$1', [recoveryKey])
    )[0];
    return row?.state === 'SUCCEEDED';
  });
  assert.equal(await activeMembership(recovery.membershipId), false);
  assert.equal(
    (
      await query(
        'finance',
        `SELECT count(*)::int n FROM outbox_events
         WHERE operation_id=$1 AND event_type='ContributionUpdated'`,
        [recoveryKey],
      )
    )[0].n,
    1,
  );
  assert.equal(
    (
      await query(
        'trip',
        `SELECT count(*)::int n FROM outbox_events
         WHERE operation_id=$1 AND event_type='MemberLeft'`,
        [recoveryKey],
      )
    )[0].n,
    1,
  );
  pass('Trip failure after Finance COMMITTED recovers forward without repeating the waiver');
}
