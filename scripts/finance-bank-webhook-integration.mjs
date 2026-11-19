import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

/** Real Gateway → Finance → PostgreSQL run of the SePay webhook; no provider or bank is contacted. */
export async function runBankWebhookTests(h, { newTrip, write, enableBody }) {
  const { query, request, bearer, pass } = h;
  const { owner, holder, member, outsider } = h.actors;
  const secret = h.bankWebhookSecret;
  assert.ok(secret, 'harness must provide BANK_WEBHOOK_SEPAY_SECRET');
  const trip = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [trip, member.id],
  );
  const body = enableBody();
  body.destination = {
    ...body.destination,
    bank_code: 'VCB',
    account_number: '0001234567',
    account_name: 'BANK WEBHOOK HOLDER',
  };
  const enabled = await write(`/api/v1/trips/${trip}/fund`, body);
  assert.equal(enabled.status, 201, JSON.stringify(enabled.body));
  const fund = enabled.body.data.id;
  const dest = (
    await query('finance', 'SELECT * FROM payment_destinations WHERE fund_id=$1', [fund])
  )[0];
  assert.equal(
    (
      await write(
        `/api/v1/funds/${fund}/destinations/${dest.id}/confirm`,
        { expected_version: 1, expected_finance_version: 1 },
        holder,
      )
    ).status,
    200,
  );
  const created = await write(`/api/v1/funds/${fund}/contribution-requests`, {
    title: 'Bank webhook',
    contributions: [
      { member_user_id: member.id, amount: '300000', destination_id: dest.id },
      { member_user_id: owner.id, amount: '200000', destination_id: dest.id },
    ],
    expected_finance_version: 2,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const memberContribution = created.body.data.contributions.find(
    (row) => row.member_user_id === member.id,
  );
  const ownerContribution = created.body.data.contributions.find(
    (row) => row.member_user_id === owner.id,
  );
  const referenceOf = async (row, user) => {
    const r = await request(
      `/api/v1/contributions/${row.id}/vietqr`,
      'GET',
      undefined,
      bearer(user),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.data.reference, /^[A-Z0-9]{25}$/);
    return r.body.data.reference;
  };
  const reference = await referenceOf(memberContribution, member);
  const ownerReference = await referenceOf(ownerContribution, owner);
  const url = `${h.gatewayUrl}/api/v1/webhooks/bank/sepay`;
  let nextId = 90000 + Math.floor(Math.random() * 1000);
  const post = async (payload, options = {}) => {
    const raw = JSON.stringify(payload);
    const ts = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature =
      options.signature ??
      `sha256=${createHmac('sha256', options.secret ?? secret)
        .update(`${ts}.${raw}`)
        .digest('hex')}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sepay-signature': signature,
        'x-sepay-timestamp': ts,
      },
      body: raw,
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  };
  const tx = (overrides = {}) => ({
    id: nextId++,
    gateway: 'Vietcombank',
    transactionDate: '2026-11-12 20:15:00',
    accountNumber: '0001234567',
    subAccount: null,
    code: null,
    content: `CK ${reference} tien quy`,
    transferType: 'in',
    transferAmount: 300000,
    referenceCode: `FT${nextId}`,
    description: 'MBVCB',
    accumulated: 0,
    ...overrides,
  });
  const ledgerCount = async () =>
    (
      await query('finance', 'SELECT count(*)::int n FROM fund_transactions WHERE fund_id=$1', [
        fund,
      ])
    )[0].n;
  const contribution = async (id) =>
    (
      await query(
        'finance',
        'SELECT status,version,confirmed_by_user_id FROM contributions WHERE id=$1',
        [id],
      )
    )[0];

  const forged = await post(tx(), { signature: `sha256=${'0'.repeat(64)}` });
  assert.equal(forged.status, 401, JSON.stringify(forged.body));
  assert.equal(forged.body.success, false);
  assert.equal((await post(tx(), { secret: 'x'.repeat(32) })).status, 401);
  assert.equal((await post(tx(), { timestamp: Math.floor(Date.now() / 1000) - 400 })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tx()),
      })
    ).status,
    401,
  );
  assert.equal((await fetch(url, { method: 'GET' })).status, 404);
  assert.equal(
    (await query('finance', 'SELECT count(*)::int n FROM bank_transfer_receipts', []))[0].n,
    0,
  );
  pass('bank webhook: unsigned, forged or expired deliveries are rejected before any write');

  const matched = tx();
  const ok = await post(matched);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.status, 'MATCHED');
  const confirmed = await contribution(memberContribution.id);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.confirmed_by_user_id, null);
  assert.equal(await ledgerCount(), 1);
  const fundRow = (
    await query('finance', 'SELECT current_balance::text,finance_version FROM funds WHERE id=$1', [
      fund,
    ])
  )[0];
  assert.equal(fundRow.current_balance, '300000');
  // enable(1) → destination confirmed(2) → request created(3) → bank transfer settled(4)
  assert.equal(fundRow.finance_version, 4);
  const audit = await query(
    'finance',
    "SELECT actor_user_id,system_actor,details FROM finance_audit_logs WHERE fund_id=$1 AND action='CONFIRM_BANK_TRANSFER'",
    [fund],
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, null);
  assert.equal(audit[0].system_actor, 'BANK_WEBHOOK:SEPAY');
  assert.equal(audit[0].details.bank_transfer_receipt_id, ok.body.receipt_id);
  assert.equal(
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1 AND event_type='ContributionUpdated' AND system_actor='BANK_WEBHOOK:SEPAY'",
        [fund],
      )
    )[0].n,
    1,
  );
  const replay = await post(matched);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receipt_id, ok.body.receipt_id);
  assert.equal(replay.body.status, 'MATCHED');
  assert.equal(await ledgerCount(), 1);
  const resent = await post(tx());
  assert.equal(resent.body.status, 'NEEDS_REVIEW');
  assert.equal(await ledgerCount(), 1);
  const listed = await request(
    `/api/v1/funds/${fund}/contributions?limit=20`,
    'GET',
    undefined,
    bearer(member),
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(
    listed.body.data.items.find((row) => row.id === memberContribution.id).status,
    'CONFIRMED',
  );
  pass(
    'bank webhook: a verified exact transfer confirms the contribution once with a system audit; replays and re-sent transfers never post twice',
  );

  const short = await post(tx({ content: `CK ${ownerReference}`, transferAmount: 150000 }));
  assert.equal(short.body.status, 'NEEDS_REVIEW');
  assert.equal((await contribution(ownerContribution.id)).status, 'PENDING');
  const wrongAccount = await post(
    tx({ content: `CK ${ownerReference}`, transferAmount: 200000, accountNumber: '9999999999' }),
  );
  assert.equal(wrongAccount.body.status, 'NEEDS_REVIEW');
  const outgoing = await post(tx({ transferType: 'out', content: 'rut tien mat' }));
  assert.equal(outgoing.body.status, 'IGNORED');
  const unknown = await post(tx({ content: 'CK khong ro noi dung' }));
  assert.equal(unknown.body.status, 'UNMATCHED');
  const ambiguous = await post(
    tx({ content: `${reference} ${ownerReference}`, transferAmount: 200000 }),
  );
  assert.equal(ambiguous.body.status, 'NEEDS_REVIEW');
  assert.equal((await contribution(ownerContribution.id)).status, 'PENDING');
  assert.equal(await ledgerCount(), 1);
  const exact = await post(
    tx({ content: `vcb ${ownerReference.toLowerCase()}`, transferAmount: 200000 }),
  );
  assert.equal(exact.body.status, 'MATCHED', JSON.stringify(exact.body));
  assert.equal(await ledgerCount(), 2);
  assert.equal((await contribution(ownerContribution.id)).status, 'CONFIRMED');
  pass(
    'bank webhook: wrong amount/account, outgoing, unknown or ambiguous references are kept for review and never posted',
  );

  const listPath = `/api/v1/funds/${fund}/bank-transfers`;
  const holderList = await request(listPath, 'GET', undefined, bearer(holder));
  assert.equal(holderList.status, 200, JSON.stringify(holderList.body));
  const items = holderList.body.data.items;
  assert.ok(items.length >= 8, `expected receipts, got ${items.length}`);
  assert.ok(
    items.every(
      (item) =>
        item.account_number_masked === '******4567' || item.account_number_masked === '******9999',
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.processing_status === 'MATCHED' && item.contribution_id === memberContribution.id,
    ),
  );
  assert.ok(items.some((item) => item.review_reason === 'AMOUNT_MISMATCH'));
  assert.ok(items.some((item) => item.review_reason === 'ACCOUNT_MISMATCH'));
  assert.ok(items.some((item) => item.processing_status === 'UNMATCHED'));
  assert.ok(items.some((item) => item.processing_status === 'IGNORED'));
  const serialized = JSON.stringify(holderList.body);
  assert.equal(serialized.includes('0001234567'), false);
  assert.equal(serialized.includes('"payload"'), false);
  assert.equal((await request(listPath, 'GET', undefined, bearer(owner))).status, 200);
  assert.equal((await request(listPath, 'GET', undefined, bearer(member))).status, 403);
  assert.ok(
    [403, 404].includes((await request(listPath, 'GET', undefined, bearer(outsider))).status),
  );
  assert.equal((await request(listPath, 'GET')).status, 401);
  pass('bank webhook: Owner/Holder read masked receipts; members and outsiders cannot');

  // Holder resolution of transfers needing review, and the closure blocker it clears.
  const readiness = async () => {
    const r = await request(`/api/v1/funds/${fund}/closure-readiness`, 'GET', undefined, bearer(owner));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  };
  const reviewIds = (
    await query(
      'finance',
      "SELECT id FROM bank_transfer_receipts WHERE fund_id=$1 AND processing_status='NEEDS_REVIEW' ORDER BY received_at",
      [fund],
    )
  ).map((row) => row.id);
  assert.ok(reviewIds.length >= 3, `expected several transfers needing review, got ${reviewIds.length}`);
  const blocked = await readiness();
  assert.equal(blocked.ready, false);
  assert.deepEqual(
    blocked.blockers.find((item) => item.kind === 'BANK_TRANSFERS_REVIEW'),
    { kind: 'BANK_TRANSFERS_REVIEW', count: reviewIds.length },
  );
  assert.equal(blocked.bank_transfers_needing_review, reviewIds.length);
  const financeVersion = async () =>
    (await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [fund]))[0]
      .finance_version;
  const resolvePath = (transfer) => `/api/v1/funds/${fund}/bank-transfers/${transfer}/resolve`;
  const resolveBody = async (overrides = {}) => ({
    resolution: 'RETURNED_TO_SENDER',
    note: 'Đã chuyển trả người gửi',
    expected_finance_version: await financeVersion(),
    ...overrides,
  });
  const resolveAs = async (transfer, user, body, key = randomUUID()) =>
    request(resolvePath(transfer), 'POST', body, { ...bearer(user), 'idempotency-key': key });
  const ledgerBefore = await ledgerCount();
  const [first, second, ...rest] = reviewIds;
  assert.equal((await resolveAs(first, member, await resolveBody())).status, 403);
  assert.equal((await resolveAs(first, owner, await resolveBody())).status, 403);
  assert.ok([403, 404].includes((await resolveAs(first, outsider, await resolveBody())).status));
  assert.equal((await resolveAs(first, holder, await resolveBody({ note: '  ' }))).status, 400);
  assert.equal(
    (await resolveAs(first, holder, await resolveBody({ resolution: 'MATCHED' }))).status,
    400,
  );
  assert.equal(
    (await request(resolvePath(first), 'POST', await resolveBody(), bearer(holder))).status,
    400,
    'Idempotency-Key is required',
  );
  const key = randomUUID();
  const versionBefore = await financeVersion();
  const firstBody = await resolveBody();
  const resolved = await resolveAs(first, holder, firstBody, key);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.data.processing_status, 'RESOLVED');
  assert.equal(resolved.body.data.resolution, 'RETURNED_TO_SENDER');
  assert.equal(resolved.body.data.resolved_by_user_id, holder.id);
  assert.equal(await financeVersion(), versionBefore + 1);
  const replayed = await resolveAs(first, holder, firstBody, key);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.data.resolved_at, resolved.body.data.resolved_at);
  assert.equal(await financeVersion(), versionBefore + 1, 'a replay does not move the Fund again');
  assert.equal(
    (await resolveAs(first, holder, { ...firstBody, note: 'Khác' }, key)).status,
    409,
    'same key, different intent',
  );
  assert.equal((await resolveAs(first, holder, await resolveBody())).status, 409, 'already resolved');
  assert.equal(
    (await resolveAs(second, holder, await resolveBody({ expected_finance_version: versionBefore }))).status,
    409,
    'stale Fund version',
  );
  assert.equal(await ledgerCount(), ledgerBefore, 'resolving never posts money');
  assert.equal(
    (
      await query(
        'finance',
        "SELECT count(*)::int AS n FROM finance_audit_logs WHERE entity_id=$1 AND action='RESOLVE_BANK_TRANSFER' AND actor_user_id=$2",
        [first, holder.id],
      )
    )[0].n,
    1,
  );
  for (const transfer of [second, ...rest]) {
    const r = await resolveAs(transfer, holder, await resolveBody({ resolution: 'NOT_OURS', note: 'Không thuộc quỹ' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const cleared = await readiness();
  assert.equal(cleared.bank_transfers_needing_review, 0);
  assert.equal(
    cleared.blockers.some((item) => item.kind === 'BANK_TRANSFERS_REVIEW'),
    false,
  );
  const listedAfter = (await request(listPath, 'GET', undefined, bearer(owner))).body.data.items;
  assert.ok(
    listedAfter.some(
      (item) =>
        item.id === first && item.resolution_note === 'Đã chuyển trả người gửi' && item.resolved_at,
    ),
  );
  pass(
    'bank webhook: only the Holder resolves transfers needing review (idempotent, versioned, no ledger effect); closure readiness blocks until all are resolved',
  );
}
