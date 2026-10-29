import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { FinanceClient } = require('../apps/api-gateway/dist/finance-client.js');
const contractRequire = createRequire(
  new URL('../packages/contracts/package.json', import.meta.url),
);
const Ajv = contractRequire('ajv/dist/2020').default;
const addFormats = contractRequire('ajv-formats').default;
const spec = JSON.parse(
  await readFile(new URL('../docs/api/finance-history.openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateResponse = ajv.compile({
  $defs: JSON.parse(
    JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'),
  ),
  $ref: '#/$defs/HistoryResponse',
});

/** All SQL fixtures and fault injection run only inside the harness's disposable databases. */
export async function runFinanceHistoryTests(h) {
  const { request, query, transaction, bearer, tripBody, pass, actors, whileTripStopped, waitFor } =
    h;
  const { owner, holder, member, outsider } = actors;
  const makeFund = async (user) => {
    const response = await request(
      '/api/v1/trips',
      'POST',
      tripBody('Finance history'),
      bearer(user),
    );
    assert.equal(response.status, 201);
    const tripId = response.body.data.id;
    const [fund] = await query(
      'finance',
      'INSERT INTO funds(trip_id,holder_user_id) VALUES($1,$2) RETURNING id',
      [tripId, user.id],
    );
    return { tripId, id: fund.id, path: `/api/v1/funds/${fund.id}/history` };
  };
  const f = await makeFund(owner),
    empty = await makeFund(owner),
    other = await makeFund(outsider);
  for (const user of [holder, member])
    await query(
      'trip',
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
      [f.tripId, user.id],
    );
  const get = async (suffix = '', user = owner, path = f.path) => {
    const response = await request(path + suffix, 'GET', undefined, bearer(user));
    if (response.status === 200)
      assert(validateResponse(response.body), JSON.stringify(validateResponse.errors));
    return response;
  };
  assert.equal((await request(f.path)).status, 401);
  assert.equal(
    (await request(f.path, 'GET', undefined, { authorization: 'Bearer invalid' })).status,
    401,
  );
  assert.equal((await get('', outsider)).status, 404);
  assert.equal((await get('', owner, other.path)).status, 404);
  assert.equal((await get('', owner, `/api/v1/funds/${randomUUID()}/history`)).status, 404);
  await waitFor(async () => (await get('', owner, empty.path)).status === 200);
  assert.deepEqual((await get('', owner, empty.path)).body.data, { items: [], next_cursor: null });
  assert.equal((await request(f.path, 'POST', {}, bearer(owner))).status, 404);
  pass('API162 distinguishes missing/empty Fund and enforces session/current Member access');

  // A real writer creates the audit row; reading must not mutate Finance state.
  const patched = await request(
    `/api/v1/funds/${f.id}/budget`,
    'PATCH',
    { budget_amount: '9007199254740993', expected_finance_version: 1 },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(patched.status, 200);
  const writeHistory = await get();
  assert.equal(writeHistory.status, 200);
  assert.equal(writeHistory.body.data.items[0].action, 'UPDATE_FUND_BUDGET');
  assert.equal(writeHistory.body.data.items[0].actor_user_id, owner.id);
  const before = await query(
    'finance',
    'SELECT current_balance::text,budget_amount::text,finance_version,(SELECT count(*)::text FROM finance_audit_logs WHERE fund_id=$1) AS audit_count,(SELECT count(*)::text FROM fund_transactions WHERE fund_id=$1) AS ledger_count FROM funds WHERE id=$1',
    [f.id],
  );
  for (const user of [owner, holder, member]) assert.equal((await get('', user)).status, 200);
  assert.deepEqual(
    await query(
      'finance',
      'SELECT current_balance::text,budget_amount::text,finance_version,(SELECT count(*)::text FROM finance_audit_logs WHERE fund_id=$1) AS audit_count,(SELECT count(*)::text FROM fund_transactions WHERE fund_id=$1) AS ledger_count FROM funds WHERE id=$1',
      [f.id],
    ),
    before,
  );
  pass('API162 exposes a real command audit and has no balance/version/ledger/audit write effects');

  // Controlled timestamps isolate ordering from the wall clock and retain sub-millisecond ties.
  await query(
    'finance',
    "UPDATE finance_audit_logs SET occurred_at='2026-01-01T00:00:00Z' WHERE fund_id=$1",
    [f.id],
  );
  const ids = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
  ];
  const privateValue = 'PRIVATE_HISTORY_SENTINEL';
  for (const [index, id] of ids.entries())
    await query(
      'finance',
      `INSERT INTO finance_audit_logs(id,fund_id,actor_user_id,system_actor,action,entity_type,entity_id,from_version,to_version,reason,details,occurred_at,correlation_id)
    VALUES($1,$2,$3,$4,$5,'Contribution',$6,1,2,$7,$8::jsonb,$9,$10)`,
      [
        id,
        f.id,
        index === 2 ? null : owner.id,
        index === 2 ? 'MOMO_IPN' : null,
        index === 2 ? 'CONFIRM_PROVIDER_PAYMENT' : 'REVERSE_CONTRIBUTION',
        randomUUID(),
        index === 0 ? 'Lý do điều chỉnh' : null,
        JSON.stringify({
          account_number: privateValue,
          provider_payload: privateValue,
          evidence_object_key: privateValue,
          before: { secret: privateValue },
          reason: 'Lý do đã lưu',
        }),
        index === 2 ? '2026-10-29T12:00:00.123457Z' : '2026-10-29T12:00:00.123456Z',
        randomUUID(),
      ],
    );
  for (const action of ['ADMIN_SUPPORT_READ', 'FUTURE_UNKNOWN'])
    await query(
      'finance',
      `INSERT INTO finance_audit_logs(fund_id,action,entity_type,correlation_id,details,occurred_at) VALUES($1,$2,'Support',$3,$4::jsonb,'2026-12-31')`,
      [f.id, action, randomUUID(), JSON.stringify({ reason: privateValue })],
    );
  const first = await get('?limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.data.items[0].id, ids[2]);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(first.body.data.items[0].occurred_at, '2026-10-29T12:00:00.123457Z');
  assert.equal(first.body.data.items[0].actor_user_id, null);
  assert.equal(first.body.data.items[0].system_actor, 'MOMO_IPN');
  const cursor = first.body.data.next_cursor;
  const seen = [ids[2]];
  let next = cursor;
  while (next) {
    const response = await get(`?limit=1&cursor=${encodeURIComponent(next)}`);
    assert.equal(response.status, 200);
    assert(!JSON.stringify(response.body).includes(privateValue));
    seen.push(...response.body.data.items.map((item) => item.id));
    next = response.body.data.next_cursor;
  }
  assert.deepEqual(seen.slice(0, 3), [ids[2], ids[1], ids[0]]);
  assert.equal(new Set(seen).size, seen.length);
  const all = (await get()).body.data.items;
  assert.equal(all.length, 4);
  assert.equal(all.find((item) => item.id === ids[0]).reason, 'Lý do điều chỉnh');
  assert.equal(all.find((item) => item.id === ids[1]).reason, 'Lý do đã lưu');
  assert(!JSON.stringify(all).includes(privateValue));
  assert(all.every((item) => !('details' in item) && !('operation_id' in item)));
  pass(
    'API162 preserves microsecond/id ordering, system actors and safe reasons; hides support/future/raw audit data',
  );

  const appended = randomUUID();
  await query(
    'finance',
    "INSERT INTO finance_audit_logs(id,fund_id,action,entity_type,correlation_id,occurred_at) VALUES($1,$2,'UPDATE_FUND_BUDGET','Fund',$3,'2026-11-01')",
    [appended, f.id, randomUUID()],
  );
  const laterPage = await get(`?cursor=${cursor}`);
  assert.equal(laterPage.status, 200);
  assert(!laterPage.body.data.items.some((item) => item.id === appended));
  assert.equal((await get(`?cursor=${cursor}`, member)).status, 400);
  assert.equal((await get(`?cursor=${cursor}`, owner, empty.path)).status, 400);
  for (const suffix of [
    '?limit=0',
    '?limit=101',
    '?limit=1&limit=2',
    '?cursor=',
    '?cursor=bad',
    '?actor_user_id=' + outsider.id,
    '?type=SUPPORT',
  ])
    assert.equal((await get(suffix)).status, 400, suffix);
  pass(
    'API162 cursor binds Fund/actor, rejects malformed queries and excludes newer appends from subsequent pages',
  );

  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    f.tripId,
    member.id,
  ]);
  assert.equal((await get('', member)).status, 404);
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [f.tripId, member.id],
  );
  assert.equal((await get('', member)).status, 200);
  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [f.tripId]);
  await query('finance', "UPDATE funds SET status='CLOSED',closed_at=now() WHERE id=$1", [f.id]);
  assert.equal((await get('', member)).status, 200);
  await query('trip', 'UPDATE trips SET deleted_at=now() WHERE id=$1', [f.tripId]);
  assert.equal((await get()).status, 404);
  await query('trip', 'UPDATE trips SET deleted_at=NULL WHERE id=$1', [f.tripId]);
  pass(
    'API162 revokes former members/deleted Trip, permits current rejoined members and archived/closed history',
  );

  const oversized = randomUUID();
  await query(
    'finance',
    "INSERT INTO finance_audit_logs(id,fund_id,action,entity_type,reason,correlation_id,occurred_at) VALUES($1,$2,'REVERSE_CONTRIBUTION','Contribution',$3,$4,'2027-01-01')",
    [oversized, f.id, 'x'.repeat(9000), randomUUID()],
  );
  assert.equal((await get()).status, 503);
  await query('finance', 'DELETE FROM finance_audit_logs WHERE id=$1', [oversized]);
  const good = new FinanceClient(h.financeTarget, h.financeSecret);
  const bad = new FinanceClient(h.financeTarget, 'x'.repeat(32));
  try {
    await assert.rejects(
      bad.call('ListFundHistory', { fund_id: f.id, actor_user_id: owner.id }, randomUUID()),
    );
    await assert.rejects(
      good.call(
        'ListFundHistory',
        { fund_id: f.id, actor_user_id: owner.id, limit: 0 },
        randomUUID(),
      ),
      (error) => error.details?.includes('VALIDATION_FAILED'),
    );
  } finally {
    good.close();
    bad.close();
  }
  pass('API162 rejects malformed stored rows without truncation and authenticates internal RPCs');

  await transaction('finance', async (client) => {
    await client.query('LOCK TABLE finance_audit_logs IN ACCESS EXCLUSIVE MODE');
    assert.equal((await get()).status, 503);
  });
  await waitFor(async () => (await get()).status === 200);
  await whileTripStopped(async () => {
    assert.equal((await get()).status, 503);
  });
  await waitFor(async () => (await get()).status === 200);
  const [index] = await query(
    'finance',
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='finance_audit_history_idx'",
  );
  assert.match(index.indexdef, /fund_id, occurred_at DESC, id DESC/);
  pass('API162 fails closed on SQL lock/Trip outage, recovers and has the keyset index');
  return { forbidden: [privateValue] };
}
