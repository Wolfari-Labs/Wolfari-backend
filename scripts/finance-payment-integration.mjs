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
  await runPreviousHolderPaymentTests(h, helpers);
}

async function runPreviousHolderPaymentTests(h, helpers) {
  const { request, query, bearer, waitFor, pass } = h;
  const { owner, holder, member } = h.actors;
  const { newTrip, write } = helpers;
  const mutate = async (path, body, user, key = randomUUID()) => {
    const invoke = () => request(path, 'POST', body, { ...bearer(user), 'idempotency-key': key });
    const first = await invoke();
    if (first.status !== 202 || !first.body?.data?.operation_id) return first;
    await waitFor(async () => {
      const r = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return r.status === 200 && ['SUCCEEDED', 'FAILED'].includes(r.body.data.state);
    });
    return invoke();
  };
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
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id;
  const fundVersion = async () =>
    (await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [fundId]))[0]
      .finance_version;
  const destination = (
    await query('finance', 'SELECT id,version FROM payment_destinations WHERE fund_id=$1', [fundId])
  )[0];
  assert.equal(
    (
      await write(
        `/api/v1/funds/${fundId}/destinations/${destination.id}/confirm`,
        { expected_version: destination.version, expected_finance_version: await fundVersion() },
        holder,
      )
    ).status,
    200,
  );
  const issue = async (amount) => {
    const r = await write(`/api/v1/funds/${fundId}/contribution-requests`, {
      title: 'Previous Holder receipt',
      contributions: [
        { member_user_id: member.id, amount: String(amount), destination_id: destination.id },
      ],
      expected_finance_version: await fundVersion(),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.contributions[0];
  };
  const attemptFor = async (c) => {
    const r = await mutate(
      `/api/v1/contributions/${c.id}/payment-attempts`,
      {
        provider: 'MOMO_SANDBOX',
        expected_version: c.version,
        expected_finance_version: await fundVersion(),
      },
      member,
    );
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitFor(
      async () =>
        (
          await query('finance', 'SELECT status FROM payment_attempts WHERE id=$1', [
            r.body.data.id,
          ])
        )[0].status === 'PENDING',
    );
    return r.body.data;
  };
  const paidContribution = await issue(1500),
    paid = await attemptFor(paidContribution);
  const lateContribution = await issue(2500),
    late = await attemptFor(lateContribution);
  const manual = await issue(3500);
  const sendSuccess = async (a, amount, transaction, responseTime = Date.now()) => {
    const stored = (
      await query('finance', 'SELECT client_request_id FROM payment_attempts WHERE id=$1', [a.id])
    )[0];
    const body = {
      partnerCode: 'MOMO_TEST',
      orderId: `WLF-${a.id}`,
      requestId: stored.client_request_id,
      amount,
      orderInfo: `Wolfari contribution ${a.contribution_id}`,
      orderType: 'momo_wallet',
      transId: transaction,
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime,
      extraData: '',
    };
    const raw = `accessKey=access&amount=${body.amount}&extraData=${body.extraData}&message=${body.message}&orderId=${body.orderId}&orderInfo=${body.orderInfo}&orderType=${body.orderType}&partnerCode=${body.partnerCode}&payType=${body.payType}&requestId=${body.requestId}&responseTime=${body.responseTime}&resultCode=${body.resultCode}&transId=${body.transId}`;
    const r = await request('/api/v1/webhooks/momo', 'POST', {
      ...body,
      signature: createHmac('sha256', 'secret').update(raw).digest('hex'),
    });
    assert.equal(r.status, 204);
  };
  await sendSuccess(paid, 1500, 812345670);
  await waitFor(
    async () =>
      (
        await query('finance', 'SELECT status FROM contributions WHERE id=$1', [
          paid.contribution_id,
        ])
      )[0].status === 'CONFIRMED',
  );
  const created = await mutate(
    `/api/v1/funds/${fundId}/holder-handovers`,
    { new_holder_user_id: owner.id, expected_finance_version: await fundVersion() },
    owner,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let handover = created.body.data;
  const action = async (name, user) => {
    const r = await mutate(
      `/api/v1/holder-handovers/${handover.id}/${name}`,
      {
        expected_version: handover.version,
        expected_finance_version: handover.finance_version,
        ...(name === 'confirm'
          ? { expected_snapshot_finance_version: handover.snapshot_finance_version }
          : {}),
      },
      user,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    handover = r.body.data;
  };
  await action('accept', owner);
  await action('confirm', holder);
  await action('confirm', owner);
  assert.equal(handover.status, 'COMPLETED');
  assert.equal(
    (await query('finance', 'SELECT holder_user_id FROM funds WHERE id=$1', [fundId]))[0]
      .holder_user_id,
    owner.id,
  );
  const ledgerCount = async (id) =>
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM fund_transactions WHERE contribution_id=$1 AND transaction_type='CONTRIBUTION'",
        [id],
      )
    )[0].n;
  const beforeReplay = await fundVersion();
  await sendSuccess(paid, 1500, 812345670, Date.now() + 1);
  await waitFor(
    async () =>
      (
        await query(
          'finance',
          "SELECT count(*)::int n FROM payment_webhook_receipts WHERE payment_attempt_id=$1 AND processing_status='PROCESSED'",
          [paid.id],
        )
      )[0].n === 2,
  );
  assert.equal(await ledgerCount(paid.contribution_id), 1);
  assert.equal(await fundVersion(), beforeReplay);
  pass(
    'Provider success already posted remains an exact money/version no-op after real Holder handover',
  );
  const reported = await mutate(
    `/api/v1/contributions/${manual.id}/report-transfer`,
    { expected_version: manual.version, expected_finance_version: await fundVersion() },
    member,
  );
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.equal(await ledgerCount(manual.id), 0);
  const confirmBody = {
    expected_version: reported.body.data.version,
    expected_finance_version: await fundVersion(),
  };
  assert.equal(
    (await mutate(`/api/v1/contributions/${manual.id}/confirm-received`, confirmBody, owner))
      .status,
    409,
  );
  assert.equal(
    (
      await mutate(
        `/api/v1/contributions/${manual.id}/confirm-received`,
        { ...confirmBody, previous_holder_transfer_confirmed: true },
        holder,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await mutate(
        `/api/v1/contributions/${manual.id}/confirm-received`,
        { ...confirmBody, previous_holder_transfer_confirmed: false },
        owner,
      )
    ).status,
    400,
  );
  assert.equal(await ledgerCount(manual.id), 0);
  const manualKey = randomUUID(),
    acknowledgedBody = { ...confirmBody, previous_holder_transfer_confirmed: true };
  const acknowledged = await mutate(
    `/api/v1/contributions/${manual.id}/confirm-received`,
    acknowledgedBody,
    owner,
    manualKey,
  );
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
  assert.deepEqual(
    (
      await mutate(
        `/api/v1/contributions/${manual.id}/confirm-received`,
        acknowledgedBody,
        owner,
        manualKey,
      )
    ).body.data,
    acknowledged.body.data,
  );
  assert.equal(await ledgerCount(manual.id), 1);
  const audit = (
    await query(
      'finance',
      "SELECT details FROM finance_audit_logs WHERE entity_id=$1 AND action='CONFIRM_RECEIVED'",
      [manual.id],
    )
  )[0].details;
  assert.equal(audit.previous_holder_transfer_confirmed, true);
  assert.equal(audit.previous_holder_user_id, holder.id);
  assert.equal(audit.current_holder_user_id, owner.id);
  pass(
    'Manual old-destination report has no ledger; current Holder must explicitly acknowledge transferred money and replay posts once',
  );
  const versionBeforeLate = await fundVersion();
  await sendSuccess(late, 2500, 812345671);
  const exception = await waitFor(
    async () =>
      (
        await query(
          'finance',
          "SELECT id FROM payment_webhook_receipts WHERE payment_attempt_id=$1 AND processing_status='NEEDS_REVIEW'",
          [late.id],
        )
      )[0],
  );
  assert.equal(await ledgerCount(late.contribution_id), 0);
  assert.equal(await fundVersion(), versionBeforeLate);
  assert.equal(
    (
      await query('finance', 'SELECT needs_reconciliation FROM payment_attempts WHERE id=$1', [
        late.id,
      ])
    )[0].needs_reconciliation,
    true,
  );
  const resolveBody = {
    resolution: 'LINKED',
    linked_attempt_id: late.id,
    reason: 'Previous Holder transferred received money to current Holder',
    expected_finance_version: await fundVersion(),
  };
  assert.equal(
    (await mutate(`/api/v1/payment-exceptions/${exception.id}/resolve`, resolveBody, owner)).status,
    409,
  );
  assert.equal(
    (
      await mutate(
        `/api/v1/payment-exceptions/${exception.id}/resolve`,
        { ...resolveBody, previous_holder_transfer_confirmed: true },
        holder,
      )
    ).status,
    403,
  );
  assert.equal(await ledgerCount(late.contribution_id), 0);
  const linkedKey = randomUUID(),
    linkedBody = { ...resolveBody, previous_holder_transfer_confirmed: true };
  const linked = await mutate(
    `/api/v1/payment-exceptions/${exception.id}/resolve`,
    linkedBody,
    owner,
    linkedKey,
  );
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.data.processing_status, 'PROCESSED');
  assert.deepEqual(
    (
      await mutate(
        `/api/v1/payment-exceptions/${exception.id}/resolve`,
        linkedBody,
        owner,
        linkedKey,
      )
    ).body.data,
    linked.body.data,
  );
  assert.equal(await ledgerCount(late.contribution_id), 1);
  const resolutionAudit = (
    await query(
      'finance',
      "SELECT details FROM finance_audit_logs WHERE entity_id=$1 AND action='RESOLVE_PAYMENT_EXCEPTION'",
      [exception.id],
    )
  )[0].details;
  assert.equal(resolutionAudit.previous_holder_transfer_confirmed, true);
  assert.equal(resolutionAudit.previous_holder_user_id, holder.id);
  assert.equal(resolutionAudit.current_holder_user_id, owner.id);
  assert.equal(resolutionAudit.reason, resolveBody.reason);
  assert.equal(
    (
      await query('finance', 'SELECT current_balance::text balance FROM funds WHERE id=$1', [
        fundId,
      ])
    )[0].balance,
    '7500',
  );
  pass(
    'Late provider success to previous Holder becomes review with no ledger; explicit current-Holder LINKED settles once with private audit',
  );
}
