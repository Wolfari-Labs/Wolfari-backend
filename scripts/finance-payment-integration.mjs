import { runPaymentCompletionRegressions } from './finance-concurrency-integration.mjs';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

export async function runPaymentTests(h, helpers) {
  const { request, query, bearer, waitFor, pass } = h;
  const { owner, holder, outsider, member } = h.actors;
  const { newTrip, write, rpc, financeDb } = helpers;
  const post = (path, body, user, key = randomUUID()) =>
    request(path, 'POST', body, { ...bearer(user), 'idempotency-key': key });
  const mutate = async (path, body, user, key = randomUUID()) => {
    const first = await post(path, body, user, key);
    if (first.status !== 202 || !first.body?.data?.operation_id) return first;
    await waitFor(async () => {
      const result = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return result.status === 200 && ['SUCCEEDED', 'FAILED'].includes(result.body.data.state);
    });
    return post(path, body, user, key);
  };
  const fundVersion = async (fundId) =>
    Number(
      (await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [fundId]))[0]
        .finance_version,
    );
  const tripId = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [tripId, member.id],
  );
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, {
    holder_user_id: holder.id,
    currency: 'VND',
    destination: {
      destination_type: 'MOMO_SANDBOX',
      momo_phone: '0900000000',
      is_default: true,
      active: true,
    },
  });
  assert.equal(enabled.status, 201, JSON.stringify(enabled.body));
  const fundId = enabled.body.data.id;
  const destination = (
    await query('finance', 'SELECT id,version FROM payment_destinations WHERE fund_id=$1', [fundId])
  )[0];
  const confirmed = await write(
    `/api/v1/funds/${fundId}/destinations/${destination.id}/confirm`,
    { expected_version: destination.version, expected_finance_version: await fundVersion(fundId) },
    holder,
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const contribution = async (amount) => {
    const created = await write(`/api/v1/funds/${fundId}/contribution-requests`, {
      title: `MoMo ${amount}`,
      contributions: [
        { member_user_id: member.id, amount: String(amount), destination_id: destination.id },
      ],
      expected_finance_version: await fundVersion(fundId),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.data.contributions[0];
  };
  const createAttempt = async (row) => {
    const result = await mutate(
      `/api/v1/contributions/${row.id}/payment-attempts`,
      {
        provider: 'MOMO_SANDBOX',
        expected_version: row.version,
        expected_finance_version: await fundVersion(fundId),
      },
      member,
    );
    assert.equal(result.status, 202, JSON.stringify(result.body));
    return result.body.data;
  };
  const attempt = await createAttempt(await contribution(50_000));
  assert.equal(attempt.provider, 'MOMO_SANDBOX');
  assert.equal(attempt.payment_url, null);
  let lastAttemptRead;
  let pending;
  try {
    pending = await waitFor(async () => {
      const result = await request(
        `/api/v1/payment-attempts/${attempt.id}`,
        'GET',
        undefined,
        bearer(member),
      );
      lastAttemptRead = result;
      return result.status === 200 && result.body.data.payment_url ? result.body.data : undefined;
    });
  } catch (error) {
    const storedAttempt = await query(
      'finance',
      'SELECT status,needs_reconciliation,error_code,provider_payload FROM payment_attempts WHERE id=$1',
      [attempt.id],
    );
    throw new Error(
      `PAYMENT_DISPATCH_TIMEOUT ${JSON.stringify({ lastAttemptRead, storedAttempt, cause: String(error) })}`,
    );
  }
  assert.match(pending.payment_url, /^https:\/\/test-payment\.momo\.vn\/mock\//);
  assert.equal(
    (await request(`/api/v1/payment-attempts/${attempt.id}`, 'GET', undefined, bearer(outsider)))
      .status,
    404,
  );
  pass('API090/091 persists the attempt before deterministic provider dispatch and scopes reads');

  const callback = (overrides = {}) => ({
    partnerCode: 'MOMO_TEST',
    orderId: `WLF-${attempt.id}`,
    requestId: '',
    amount: 50_000,
    orderInfo: `Wolfari contribution ${attempt.contribution_id}`,
    orderType: 'momo_wallet',
    transId: 123456789,
    resultCode: 0,
    message: 'Successful.',
    payType: 'qr',
    responseTime: Date.now(),
    extraData: '',
    signature: '',
    ...overrides,
  });
  const stored = (
    await query('finance', 'SELECT client_request_id FROM payment_attempts WHERE id=$1', [
      attempt.id,
    ])
  )[0];
  const sign = (body) => {
    const raw =
      `accessKey=access&amount=${body.amount}&extraData=${body.extraData}` +
      `&message=${body.message}&orderId=${body.orderId}&orderInfo=${body.orderInfo}` +
      `&orderType=${body.orderType}&partnerCode=${body.partnerCode}&payType=${body.payType}` +
      `&requestId=${body.requestId}&responseTime=${body.responseTime}` +
      `&resultCode=${body.resultCode}&transId=${body.transId}`;
    return createHmac('sha256', 'secret').update(raw).digest('hex');
  };
  const valid = callback({ requestId: stored.client_request_id });
  valid.signature = sign(valid);
  const callbacks = await Promise.all(
    Array.from({ length: 10 }, () => request('/api/v1/webhooks/momo', 'POST', valid)),
  );
  assert(callbacks.every((result) => result.status === 204));
  await waitFor(async () => {
    const rows = await query('finance', 'SELECT status FROM contributions WHERE id=$1', [
      attempt.contribution_id,
    ]);
    return rows[0].status === 'CONFIRMED';
  });
  assert.equal(
    Number(
      (
        await query(
          'finance',
          "SELECT count(*)::int n FROM fund_transactions WHERE contribution_id=$1 AND transaction_type='CONTRIBUTION'",
          [attempt.contribution_id],
        )
      )[0].n,
    ),
    1,
  );
  assert.equal(
    (
      await query('finance', 'SELECT current_balance::text balance FROM funds WHERE id=$1', [
        fundId,
      ])
    )[0].balance,
    '50000',
  );
  pass('API093 deduplicates ten valid IPNs and settles exactly one ledger IN');
  await runPaymentCompletionRegressions(h, {
    financeDb,
    attempt,
    fundId,
    transactionId: String(valid.transId),
    mutate,
  });

  const reviewAttempt = await createAttempt(await contribution(60_000));
  await waitFor(
    async () =>
      (
        await query('finance', 'SELECT status FROM payment_attempts WHERE id=$1', [
          reviewAttempt.id,
        ])
      )[0].status === 'PENDING',
  );
  const reviewStored = (
    await query('finance', 'SELECT client_request_id FROM payment_attempts WHERE id=$1', [
      reviewAttempt.id,
    ])
  )[0];
  const invalid = callback({
    orderId: `WLF-${reviewAttempt.id}`,
    requestId: reviewStored.client_request_id,
    orderInfo: `Wolfari contribution ${reviewAttempt.contribution_id}`,
    amount: 60_000,
    transId: 223456789,
    signature: '0'.repeat(64),
  });
  assert.equal((await request('/api/v1/webhooks/momo', 'POST', invalid)).status, 204);
  const mismatch = callback({
    orderId: `WLF-${reviewAttempt.id}`,
    requestId: reviewStored.client_request_id,
    orderInfo: `Wolfari contribution ${reviewAttempt.contribution_id}`,
    amount: 60_001,
    transId: 323456789,
    resultCode: 49,
    message: 'Transaction failed.',
  });
  mismatch.signature = sign(mismatch);
  assert.equal((await request('/api/v1/webhooks/momo', 'POST', mismatch)).status, 204);
  const exceptions = await waitFor(async () => {
    const result = await request(
      `/api/v1/funds/${fundId}/payment-exceptions`,
      'GET',
      undefined,
      bearer(owner),
    );
    return result.status === 200 && result.body.data.items.length
      ? result.body.data.items
      : undefined;
  });
  assert(exceptions.every((item) => item.review_reason !== 'INVALID_SIGNATURE'));
  const exception = exceptions.find((item) => item.review_reason === 'AMOUNT_MISMATCH');
  assert(exception);
  const memberRow = (
    await query('trip', 'SELECT id FROM trip_members WHERE trip_id=$1 AND user_id=$2', [
      tripId,
      member.id,
    ])
  )[0];
  const lifecycle = await rpc('ExecuteTripOperation', {
    operation_id: randomUUID(),
    request_hash: 'a'.repeat(64),
    operation_type: 'LEAVE_MEMBER',
    authorization_context: {
      actor: { actor_user_id: member.id },
      trip_id: tripId,
      context_revision: 1,
      active_user_ids: [owner.id, holder.id, member.id],
      command_scope: 'LEAVE_MEMBER',
    },
    membership_target: {
      membership_id: memberRow.id,
      user_id: member.id,
      reason: 'Leave after resolving payment',
    },
  });
  assert.equal(lifecycle.receipt.outcome.error_code, 'FINANCE_OBLIGATION_BLOCKED');
  assert.deepEqual(lifecycle.receipt.outcome.blocking_ids ?? [], []);
  const resolved = await mutate(
    `/api/v1/payment-exceptions/${exception.id}/resolve`,
    {
      resolution: 'NO_FINANCIAL_EFFECT',
      reason: 'Provider reported a failed transaction with a mismatched amount',
      expected_finance_version: await fundVersion(fundId),
    },
    holder,
  );
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.data.processing_status, 'IGNORED');
  const reconcile = await mutate(
    `/api/v1/payment-attempts/${reviewAttempt.id}/reconcile`,
    { reason: 'Verify the unresolved provider state' },
    holder,
  );
  assert.equal(reconcile.status, 202, JSON.stringify(reconcile.body));
  pass('API092/094/095 keeps bad signatures private, exposes review safely and blocks member exit');
}
