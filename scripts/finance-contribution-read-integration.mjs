import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FinanceClient } = require('../apps/api-gateway/dist/finance-client.js');

/** Test-only SQL fixtures cover statuses whose mutation APIs are still outside this increment. */
export async function runContributionReadTests(h, fixture) {
  const { request, query, bearer, pass } = h;
  const { owner, holder, member, outsider } = h.actors;
  const { fundId, tripId, emptyFundId, created, replay, operationId } = fixture;
  const requestsPath = `/api/v1/funds/${fundId}/contribution-requests`,
    contributionsPath = `/api/v1/funds/${fundId}/contributions`;
  const get = (path, user = owner) => request(path, 'GET', undefined, bearer(user));
  const page = async (path, user = owner) => {
    const r = await get(path, user);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  };
  const fund = async () => (await query('finance', 'SELECT * FROM funds WHERE id=$1', [fundId]))[0];
  for (const endpoint of ['contribution-requests', 'contributions']) {
    assert.deepEqual(await page(`/api/v1/funds/${emptyFundId}/${endpoint}`), {
      items: [],
      next_cursor: null,
    });
    assert.equal((await get(`/api/v1/funds/${randomUUID()}/${endpoint}`)).status, 404);
    const path = `/api/v1/funds/${fundId}/${endpoint}`;
    assert.equal((await request(path, 'GET')).status, 401);
    assert.equal((await get(path, outsider)).status, 404);
    for (const actor of [owner, holder, member]) assert.equal((await get(path, actor)).status, 200);
  }
  const initial = await page(requestsPath + '?limit=100');
  const issued = initial.items.find((row) => row.id === created.id);
  assert(issued);
  assert.equal(issued.contributions.length, created.contributions.length);
  assert.equal(issued.finance_version, (await fund()).finance_version);
  assert.deepEqual(
    issued.contributions.map((c) => c.id).sort(),
    created.contributions.map((c) => c.id).sort(),
  );
  for (const c of issued.contributions) assert.equal(c.finance_version, issued.finance_version);
  for (const suffix of [
    '?limit=0',
    '?limit=101',
    '?limit=1&limit=2',
    '?cursor=bad',
    '?sort=asc',
    '?actor_user_id=' + owner.id,
  ])
    assert.equal((await get(requestsPath + suffix)).status, 400);
  for (const suffix of [
    '?status=BOGUS',
    '?member_user_id=bad',
    '?request_id=' + created.id,
    '?status=PENDING&status=CONFIRMED',
  ])
    assert.equal((await get(contributionsPath + suffix)).status, 400);
  pass(
    'API079/080 authorize every role/session; distinguish absent Fund from empty lists and reject invalid query',
  );

  // Seed exact microsecond ties, all statuses and many allocations in the isolated test DB.
  const statuses = ['PENDING', 'TRANSFER_REPORTED', 'CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED'];
  const seededRequests = [];
  for (let n = 0; n < 6; n++) {
    const id = randomUUID();
    seededRequests.push(id);
    const at = `2020-01-01T00:00:00.${n < 3 ? '123456' : '123455'}Z`;
    await query(
      'finance',
      `INSERT INTO contribution_requests(id,fund_id,title,created_by_user_id,created_at,status,version,closed_at,note)
      VALUES($1,$2,$3,$4,$5,$6::varchar,3,CASE WHEN $6::varchar='OPEN' THEN NULL ELSE $5::timestamptz END,NULL)`,
      [id, fundId, 'Read fixture ' + n, owner.id, at, ['OPEN', 'CLOSED', 'CANCELLED'][n % 3]],
    );
    await query(
      'finance',
      `INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,
      created_at,self_contribution,version,member_reported_at,confirmed_at,confirmed_by_user_id,waived_reason,cancelled_reason,rejected_reason,transfer_evidence_object_key)
      VALUES($1,$2,$3,$4,9223372036854775807,$5,'{"private":"READ_PRIVATE_BANK"}',1,$6,false,4,$6,$6,$7,'Waived fixture','Cancelled fixture','Public rejection feedback','READ_PRIVATE_EVIDENCE')`,
      [randomUUID(), id, fundId, member.id, statuses[n], at, holder.id],
    );
  }
  // A single request with >100 allocations must not inherit the outer page limit.
  await query(
    'finance',
    `INSERT INTO contributions(request_id,fund_id,member_user_id,amount,destination_snapshot,destination_version)
    SELECT $1,$2,gen_random_uuid(),1,'{"private":"READ_PRIVATE_BANK"}',1 FROM generate_series(1,150)`,
    [seededRequests[0], fundId],
  );
  const snapshot = async () => {
    const result = {};
    for (const table of [
      'funds',
      'contribution_requests',
      'contributions',
      'payment_destinations',
      'command_receipts',
      'finance_audit_logs',
      'outbox_events',
      'fund_transactions',
      'payment_attempts',
      'payment_webhook_receipts',
      'fund_expenses',
      'financial_notes',
      'fund_refunds',
      'finance_closures',
      'closure_confirmations',
    ]) {
      result[table] = (
        await query(
          'finance',
          `SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS digest FROM ${table} t`,
        )
      )[0].digest;
    }
    result.trip = (
      await query(
        'trip',
        `SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY operation_id)::text,'[]')) AS digest FROM trip_operations t`,
      )
    )[0].digest;
    return result;
  };
  const beforeReads = await snapshot();
  const all = async (path) => {
    const items = [];
    let cursor = null,
      pages = 0;
    do {
      const p = await page(
        path + (path.includes('?') ? '&' : '?') + 'limit=2' + (cursor ? '&cursor=' + cursor : ''),
        member,
      );
      items.push(...p.items);
      cursor = p.next_cursor;
      assert(++pages < 200, 'pagination loop');
    } while (cursor);
    assert.equal(new Set(items.map((row) => row.id)).size, items.length);
    return items;
  };
  for (const [path, table] of [
    [requestsPath, 'contribution_requests'],
    [contributionsPath, 'contributions'],
  ]) {
    const rows = await all(path);
    const expected = await query(
      'finance',
      `SELECT id FROM ${table} WHERE fund_id=$1 ORDER BY created_at DESC,id DESC`,
      [fundId],
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      expected.map((row) => row.id),
    );
    for (const row of rows) assert.equal(row.finance_version, (await fund()).finance_version);
    const serialized = JSON.stringify(rows);
    for (const secret of [
      'READ_PRIVATE',
      'destination_snapshot',
      'destination_version',
      'transfer_evidence_object_key',
    ])
      assert(!serialized.includes(secret));
    const contributions = table === 'contribution_requests' ? rows.flatMap(row => row.contributions) : rows;
    assert(contributions.some(row => row.rejected_reason === 'Public rejection feedback'));
    assert(contributions.every(row => row.rejected_reason === null || typeof row.rejected_reason === 'string'));
    if (table === 'contribution_requests')
      assert.equal(rows.find((row) => row.id === seededRequests[0]).contributions.length, 151);
  }
  assert.equal((await page(contributionsPath)).items.length, 20);
  assert.equal((await page(contributionsPath + '?limit=100')).items.length, 100);
  for (const status of statuses) {
    const rows = await all(
      contributionsPath + '?status=' + status + '&member_user_id=' + member.id,
    );
    assert(rows.length > 0);
    assert(rows.every((row) => row.status === status && row.member_user_id === member.id));
    assert(rows.some((row) => row.amount === '9223372036854775807'));
  }
  assert.deepEqual(await page(contributionsPath + '?member_user_id=' + randomUUID()), {
    items: [],
    next_cursor: null,
  });
  const first = await page(contributionsPath + '?limit=1');
  for (const path of [
    requestsPath,
    `/api/v1/funds/${emptyFundId}/contributions`,
    contributionsPath + '?status=PENDING',
  ])
    assert.equal(
      (await get(path + (path.includes('?') ? '&' : '?') + 'cursor=' + first.next_cursor)).status,
      400,
    );
  assert.deepEqual(await snapshot(), beforeReads);
  pass(
    'API079/080 preserve microsecond/id order, all six statuses, exact int64, complete nested allocations and no GET writes',
  );

  const beforeAppend = await page(requestsPath + '?limit=1');
  const pendingPage = await page(contributionsPath + '?status=PENDING&limit=1');
  await query(
    'finance',
    "UPDATE contributions SET status='CONFIRMED',version=version+1 WHERE id=$1",
    [pendingPage.items[0].id],
  );
  const pendingNext = await page(
    contributionsPath + '?status=PENDING&limit=100&cursor=' + pendingPage.next_cursor,
  );
  assert(
    pendingNext.items.every(
      (row) => row.status === 'PENDING' && row.id !== pendingPage.items[0].id,
    ),
  );
  const appended = randomUUID();
  await query(
    'finance',
    `INSERT INTO contribution_requests(id,fund_id,title,created_by_user_id,created_at) VALUES($1,$2,'Newer row',$3,clock_timestamp()+interval '1 day')`,
    [appended, fundId, owner.id],
  );
  const continuation = await page(requestsPath + '?limit=100&cursor=' + beforeAppend.next_cursor);
  assert(
    !continuation.items.some((row) => row.id === appended || row.id === beforeAppend.items[0].id),
  );
  assert.equal((await page(requestsPath + '?limit=1')).items[0].id, appended);
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  assert.equal((await get(contributionsPath + '?cursor=' + first.next_cursor, member)).status, 404);
  assert((await page(contributionsPath + '?member_user_id=' + member.id, owner)).items.length > 0);
  await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [tripId]);
  for (const status of ['CLOSING', 'CLOSED']) {
    await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [fundId, status]);
    for (const path of [requestsPath, contributionsPath])
      assert.equal((await get(path, member)).status, 200);
  }
  await query('trip', 'UPDATE trips SET deleted_at=now() WHERE id=$1', [tripId]);
  for (const path of [requestsPath, contributionsPath])
    assert.equal((await get(path, owner)).status, 404);
  await query('trip', 'UPDATE trips SET deleted_at=NULL,archived_at=NULL WHERE id=$1', [tripId]);
  await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fundId]);
  pass(
    'API079/080 bind cursors, exclude newer appends, revoke between pages and allow archived/closed history only to current members',
  );

  // Replay remains the creation snapshot, not the current read state.
  await query(
    'finance',
    "UPDATE contributions SET status='CONFIRMED',version=2,confirmed_at=now(),confirmed_by_user_id=$2 WHERE request_id=$1",
    [created.id, holder.id],
  );
  await query('finance', 'UPDATE funds SET finance_version=finance_version+1 WHERE id=$1', [
    fundId,
  ]);
  assert.deepEqual((await replay()).body.data, created);
  const current = (await page(requestsPath + '?limit=100')).items.find(
    (row) => row.id === created.id,
  );
  assert(current.contributions.every((row) => row.status === 'CONFIRMED' && row.version === 2));
  assert(current.finance_version > created.finance_version);
  const saved = (
    await query('finance', 'SELECT response FROM command_receipts WHERE operation_id=$1', [
      operationId,
    ])
  )[0].response;
  try {
    await query(
      'finance',
      `UPDATE command_receipts SET response=response #- '{contributionRequest,contributions}' #- '{contributionRequest,finance_version}' WHERE operation_id=$1`,
      [operationId],
    );
    const legacy = await replay();
    assert.equal(legacy.status, 201);
    const { contributions, finance_version, ...old } = created;
    assert(contributions.length > 0 && finance_version > 0);
    assert.deepEqual(legacy.body.data, old);
    await query(
      'finance',
      `UPDATE command_receipts SET response=jsonb_set(response,'{contributionRequest,finance_version}','3') WHERE operation_id=$1`,
      [operationId],
    );
    assert.equal((await replay()).status, 503);
  } finally {
    await query('finance', 'UPDATE command_receipts SET response=$2::jsonb WHERE operation_id=$1', [
      operationId,
      JSON.stringify(saved),
    ]);
  }
  pass(
    'API078 full and legacy receipts replay saved results; malformed partial snapshots fail and current GET states remain separate',
  );

  const rpc = new FinanceClient(h.financeTarget, h.gatewaySecret);
  const wrong = new FinanceClient(h.financeTarget, 'x'.repeat(64));
  try {
    for (const method of ['ListContributionRequests', 'ListContributions']) {
      assert(
        (
          await rpc.call(
            method,
            { actor_user_id: member.id, fund_id: fundId, limit: 1 },
            randomUUID(),
          )
        ).items.length === 1,
      );
      await assert.rejects(
        wrong.call(method, { actor_user_id: member.id, fund_id: fundId }, randomUUID()),
      );
    }
    // Exercise the real default receive limit; never silently truncate a nested request.
    await query(
      'finance',
      "UPDATE contribution_requests SET note=repeat('x',5242880) WHERE id=$1",
      [appended],
    );
    try {
      await assert.rejects(
        rpc.call(
          'ListContributionRequests',
          { actor_user_id: member.id, fund_id: fundId, limit: 1 },
          randomUUID(),
        ),
        (error) => error.code === 8,
      );
      const oversized = await get(requestsPath + '?limit=1');
      assert.equal(oversized.status, 503);
      assert(!('data' in oversized.body));
    } finally {
      await query('finance', 'UPDATE contribution_requests SET note=NULL WHERE id=$1', [appended]);
    }
  } finally {
    rpc.close();
    wrong.close();
  }
  await h.whileTripStopped(async () => {
    for (const path of [requestsPath, contributionsPath])
      assert.equal((await get(path)).status, 503);
  });
  await h.waitFor(async () => (await get(requestsPath)).status === 200);
  await query('finance', 'ALTER TABLE contributions RENAME TO contributions_read_failure');
  try {
    for (const path of [requestsPath, contributionsPath]) {
      const r = await get(path);
      assert.equal(r.status, 503);
      assert(!('data' in r.body));
    }
  } finally {
    await query('finance', 'ALTER TABLE contributions_read_failure RENAME TO contributions');
  }
  assert.equal((await get(requestsPath)).status, 200);
  pass(
    'API079/080 authenticate internal RPCs and return 503 on transport-size/Trip/SQL failure without truncating or fabricating data',
  );
}
