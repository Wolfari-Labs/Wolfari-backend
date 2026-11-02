import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api-gateway/package.json', import.meta.url));
const { Client, credentials, Metadata, status } = require('@grpc/grpc-js');
const { loadSync } = require('@grpc/proto-loader');
const { PROTO_PATHS, GRPC_LOADER_OPTIONS } = require('@wolfari/contracts/grpc');
const methods = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
  'wolfari.finance.v1.FinanceService'
];
const privateValues = [
  'AUTOMATION PRIVATE REQUEST',
  'AUTOMATION PRIVATE NOTE',
  '000123456789',
  'fixture/private-transfer-evidence',
  'AUTOMATION PRIVATE CLOSURE',
];
const financeTables = [
  'funds',
  'payment_destinations',
  'contribution_requests',
  'contributions',
  'payment_attempts',
  'payment_webhook_receipts',
  'fund_expenses',
  'financial_notes',
  'fund_refunds',
  'fund_transactions',
  'finance_closures',
  'closure_confirmations',
  'command_receipts',
  'payment_provider_configs',
  'outbox_events',
  'finance_audit_logs',
  'finance_files',
];

/** Synthetic states in the harness-owned database; all authorization uses the real Trip gRPC service. */
export async function runFinanceAutomationContextTests(h) {
  const { request, query, bearer, tripBody, pass, waitFor, whileTripStopped } = h;
  const { owner, holder, member, outsider } = h.actors;
  const client = new Client(h.financeTarget, credentials.createInsecure());
  const snapshot = () =>
    query(
      'finance',
      financeTables
        .map(
          (table) =>
            `SELECT '${table}' AS name,count(*)::text AS count,
       md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS fingerprint
     FROM ${table} t`,
        )
        .join(' UNION ALL ') + ' ORDER BY name',
    );
  const rpc = async (input, options = {}) => {
    const before = await snapshot();
    const metadata = new Metadata();
    const headers = {
      'x-caller-service': ['Automation'],
      'x-service-secret': [h.automationSecret],
      'x-correlation-id': [randomUUID()],
      ...options.headers,
    };
    for (const [key, values] of Object.entries(headers))
      for (const value of values) metadata.add(key, value);
    const method = methods[options.method ?? 'GetAutomationContext'];
    try {
      return await new Promise((resolve, reject) =>
        client.makeUnaryRequest(
          method.path,
          method.requestSerialize,
          method.responseDeserialize,
          input,
          metadata,
          { deadline: Date.now() + (options.deadlineMs ?? 3000) },
          (error, result) => (error ? reject(error) : resolve(result)),
        ),
      );
    } finally {
      assert.deepEqual(
        await snapshot(),
        before,
        'context reads must not change any Finance business table',
      );
    }
  };
  const denied = (input, code, options) =>
    assert.rejects(rpc(input, options), (error) => error.code === code);
  const source = (fundId, sourceType, sourceId) => ({
    fund_id: fundId,
    source_type: sourceType,
    source_id: sourceId,
  });
  const check = async (input, users, dueAt = null, expectedStatus = 1) => {
    const result = await rpc(input);
    const [fund] = await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [
      input.fund_id,
    ]);
    assert.equal(result.finance_version, fund.finance_version);
    assert.equal(result.status, expectedStatus);
    const recipients = result.authorized_recipients ?? [];
    assert.deepEqual(
      recipients.map((item) => item.user_id).sort(),
      users.map((user) => user.id).sort(),
    );
    for (const recipient of recipients) assert.deepEqual(Object.keys(recipient), ['user_id']);
    const allowed = new Set([
      'finance_version',
      'status',
      'authorized_recipients',
      // proto-loader oneofs:true exposes the presence marker for a proto3 optional field.
      ...(input.source_type === 'CONTRIBUTION_REVIEW'
        ? ['source_revision', '_source_revision']
        : []),
      ...(dueAt ? ['due_at'] : []),
    ]);
    for (const key of Object.keys(result))
      assert(allowed.has(key), `Unexpected context field ${key}`);
    if (input.source_type === 'CONTRIBUTION_REVIEW') {
      const [contribution] = await query(
        'finance',
        'SELECT version FROM contributions WHERE id=$1',
        [input.source_id],
      );
      assert.equal(result.source_revision, contribution.version);
      assert.equal(result._source_revision, 'source_revision');
    } else {
      assert.equal(result.source_revision, undefined);
      assert.equal(result._source_revision, undefined);
    }
    if (dueAt) {
      const milliseconds = Date.parse(dueAt);
      assert.deepEqual(result.due_at, {
        seconds: String(Math.floor(milliseconds / 1000)),
        nanos: (milliseconds % 1000) * 1000000,
      });
    } else assert.equal(result.due_at, undefined);
    for (const value of privateValues) assert(!JSON.stringify(result).includes(value));
    return result;
  };
  const createFund = async () => {
    const created = await request(
      '/api/v1/trips',
      'POST',
      tripBody('Automation context'),
      bearer(owner),
    );
    assert.equal(created.status, 201);
    const tripId = created.body.data.id;
    for (const user of [holder, member])
      await query(
        'trip',
        "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp()-interval '2 days')",
        [tripId, user.id],
      );
    // Explicit historical fixture times make rejoin cutoffs deterministic at submillisecond precision.
    await query(
      'trip',
      "UPDATE trip_members SET joined_at=clock_timestamp()-interval '2 days' WHERE trip_id=$1",
      [tripId],
    );
    const [fund] = await query(
      'finance',
      'INSERT INTO funds(trip_id,holder_user_id,finance_version) VALUES($1,$2,7) RETURNING id',
      [tripId, holder.id],
    );
    return { tripId, fundId: fund.id };
  };
  const bump = (fundId) =>
    query(
      'finance',
      'UPDATE funds SET finance_version=finance_version+1,updated_at=clock_timestamp() WHERE id=$1',
      [fundId],
    );
  const join = (tripId, user) =>
    query(
      'trip',
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp())",
      [tripId, user.id],
    );
  const leave = (tripId, user) =>
    query(
      'trip',
      'UPDATE trip_members SET left_at=clock_timestamp() WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
      [tripId, user.id],
    );
  try {
    const f = await createFund();
    const other = await createFund();
    const due = '2050-05-20T04:05:06.123Z';
    const [collection] = await query(
      'finance',
      `INSERT INTO contribution_requests(fund_id,title,note,due_at,created_by_user_id,created_at)
       VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day') RETURNING id`,
      [f.fundId, privateValues[0], privateValues[1], due, owner.id],
    );
    const contributions = {};
    for (const user of [owner, member, outsider]) {
      const [row] = await query(
        'finance',
        `INSERT INTO contributions(request_id,fund_id,member_user_id,amount,destination_snapshot,
          destination_version,transfer_evidence_object_key,created_at)
         VALUES($1,$2,$3,250000,$4::jsonb,1,$5,clock_timestamp()-interval '1 day') RETURNING id`,
        [
          collection.id,
          f.fundId,
          user.id,
          JSON.stringify({ account_number: privateValues[2] }),
          privateValues[3],
        ],
      );
      contributions[user.id] = row.id;
    }
    const requestContext = source(f.fundId, 'CONTRIBUTION_REQUEST', collection.id);
    const dueContext = source(f.fundId, 'CONTRIBUTION_DUE', contributions[member.id]);
    const ownerDueContext = source(f.fundId, 'CONTRIBUTION_DUE', contributions[owner.id]);
    const reviewContext = source(f.fundId, 'CONTRIBUTION_REVIEW', contributions[member.id]);

    for (const headers of [
      { 'x-caller-service': ['ApiGateway'], 'x-service-secret': [h.gatewaySecret] },
      { 'x-caller-service': ['Trip'], 'x-service-secret': [h.tripFinanceSecret] },
      { 'x-service-secret': [h.gatewaySecret] },
      { 'x-service-secret': [h.tripFinanceSecret] },
      { 'x-service-secret': ['incorrect-synthetic-secret'] },
      { 'x-service-secret': [] },
      { 'x-caller-service': [] },
      { 'x-caller-service': ['Automation', 'Automation'] },
      { 'x-service-secret': [h.automationSecret, h.automationSecret] },
      { 'x-correlation-id': [] },
      { 'x-correlation-id': ['not-a-uuid'] },
      { 'x-correlation-id': [randomUUID(), randomUUID()] },
    ])
      await denied(requestContext, status.PERMISSION_DENIED, { headers });
    await denied({ trip_id: f.tripId, actor_user_id: owner.id }, status.PERMISSION_DENIED, {
      method: 'GetFund',
    });
    pass(
      'Automation context accepts only its own service credential and rejects ambiguous metadata',
    );

    for (const invalid of [
      { ...requestContext, fund_id: 'not-a-uuid' },
      { ...requestContext, fund_id: '00000000-0000-0000-0000-000000000000' },
      { ...requestContext, source_id: 'not-a-uuid' },
      { ...requestContext, source_id: '00000000-0000-0000-0000-000000000000' },
      { ...requestContext, source_type: '' },
      { ...requestContext, source_type: 'contribution_request' },
      { ...requestContext, source_type: 'UNKNOWN' },
      { ...requestContext, source_type: ' CONTRIBUTION_REQUEST' },
    ])
      await denied(invalid, status.INVALID_ARGUMENT);
    for (const type of [
      'CONTRIBUTION_REQUEST',
      'CONTRIBUTION_DUE',
      'CONTRIBUTION_REVIEW',
      'CLOSURE',
    ])
      await denied(source(f.fundId, type, randomUUID()), status.NOT_FOUND);
    for (const input of [requestContext, dueContext, reviewContext])
      await denied({ ...input, fund_id: other.fundId }, status.NOT_FOUND);
    await denied({ ...requestContext, fund_id: randomUUID() }, status.NOT_FOUND);
    await denied({ ...dueContext, source_id: collection.id }, status.NOT_FOUND);
    await check(
      {
        ...requestContext,
        fund_id: f.fundId.toUpperCase(),
        source_id: collection.id.toUpperCase(),
      },
      [owner, member],
      due,
    );
    pass(
      'Automation context validates strict identifiers and source type, and binds every source to its Fund',
    );

    await check(requestContext, [owner, member], due);
    await check(dueContext, [member], due);
    await check(reviewContext, []);
    const editedDue = '2051-06-21T05:06:07.456Z';
    await query(
      'finance',
      'UPDATE contribution_requests SET due_at=$2,version=version+1 WHERE id=$1',
      [collection.id, editedDue],
    );
    await bump(f.fundId);
    await check(requestContext, [owner, member], editedDue);
    await check(dueContext, [member], editedDue);
    await query(
      'finance',
      'UPDATE contribution_requests SET due_at=NULL,version=version+1 WHERE id=$1',
      [collection.id],
    );
    await bump(f.fundId);
    await check(requestContext, [owner, member]);
    await check(dueContext, [member]);
    await query(
      'finance',
      'UPDATE contribution_requests SET due_at=$2,version=version+1 WHERE id=$1',
      [collection.id, due],
    );
    await bump(f.fundId);
    pass(
      'Request and due contexts project current pending debtors and current optional deadline only',
    );

    await query(
      'finance',
      "UPDATE contributions SET status='TRANSFER_REPORTED',version=version+1 WHERE id=$1",
      [contributions[member.id]],
    );
    await bump(f.fundId);
    await check(dueContext, []);
    await check(requestContext, [owner], due);
    await check(reviewContext, [holder]);
    // Defensive SQL fixture only: normal lifecycle does not permit an open-Fund Holder handover.
    // REVIEW still resolves the current stored Holder without a historical membership cutoff.
    await join(f.tripId, outsider);
    await query(
      'finance',
      'UPDATE funds SET holder_user_id=$2,finance_version=finance_version+1 WHERE id=$1',
      [f.fundId, outsider.id],
    );
    await check(reviewContext, [outsider]);
    await leave(f.tripId, outsider);
    await check(reviewContext, []);
    await query(
      'finance',
      'UPDATE funds SET holder_user_id=$2,finance_version=finance_version+1 WHERE id=$1',
      [f.fundId, holder.id],
    );
    for (const terminal of ['CONFIRMED', 'WAIVED', 'CANCELLED', 'REVERSED']) {
      await query('finance', 'UPDATE contributions SET status=$2,version=version+1 WHERE id=$1', [
        contributions[member.id],
        terminal,
      ]);
      await bump(f.fundId);
      await check(dueContext, []);
      await check(reviewContext, []);
    }
    await query(
      'finance',
      "UPDATE contributions SET status='PENDING',version=version+1 WHERE id=$1",
      [contributions[member.id]],
    );
    await bump(f.fundId);
    await check(dueContext, [member], due);
    await check(reviewContext, []);
    pass(
      'Stale reminder purposes never switch roles; review uses only the current eligible Holder',
    );

    const [savedMembership] = await query(
      'trip',
      'SELECT id,joined_at::text AS joined_at FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
      [f.tripId, member.id],
    );
    const [savedContribution] = await query(
      'finance',
      'SELECT created_at::text AS created_at FROM contributions WHERE id=$1',
      [contributions[member.id]],
    );
    try {
      // Real Trip projection truncates PostgreSQL microseconds to JavaScript milliseconds.
      // A join at .000900 happened after a source at .000500 and must not regain eligibility.
      const [preciseMembership] = await query(
        'trip',
        `UPDATE trip_members SET joined_at=date_trunc('second',clock_timestamp()-interval '1 hour')
          + interval '900 microseconds' WHERE id=$1
         RETURNING joined_at::text AS joined_at,to_char(joined_at,'US') AS micros`,
        [savedMembership.id],
      );
      assert.equal(preciseMembership.micros, '000900');
      const [preciseContribution] = await query(
        'finance',
        `UPDATE contributions SET created_at=$2::timestamptz-interval '400 microseconds' WHERE id=$1
         RETURNING to_char(created_at,'US') AS micros`,
        [contributions[member.id], preciseMembership.joined_at],
      );
      assert.equal(preciseContribution.micros, '000500');
      await check(dueContext, []);
      await check(requestContext, [owner], due);
    } finally {
      await query('finance', 'UPDATE contributions SET created_at=$2::timestamptz WHERE id=$1', [
        contributions[member.id],
        savedContribution.created_at,
      ]);
      await query('trip', 'UPDATE trip_members SET joined_at=$2::timestamptz WHERE id=$1', [
        savedMembership.id,
        savedMembership.joined_at,
      ]);
    }
    await check(dueContext, [member], due);
    pass(
      'Real PostgreSQL and Trip timestamp precision cannot reauthorize a later join within the same millisecond',
    );

    // Defense fixtures bypass normal lifecycle waivers to test stale old-membership notifications.
    await leave(f.tripId, member);
    await check(dueContext, []);
    await check(requestContext, [owner], due);
    await join(f.tripId, member);
    await check(dueContext, []);
    await check(requestContext, [owner], due);
    for (const field of ['archived_at', 'deleted_at']) {
      await query('trip', `UPDATE trips SET ${field}=clock_timestamp() WHERE id=$1`, [f.tripId]);
      await check(ownerDueContext, []);
      await check(requestContext, []);
      await query('trip', `UPDATE trips SET ${field}=NULL WHERE id=$1`, [f.tripId]);
      await check(ownerDueContext, [owner], due);
    }
    pass(
      'Real Trip departure, rejoin, archive and deletion suppress stale audiences without leaking deadlines',
    );

    for (const requestStatus of ['CLOSED', 'CANCELLED']) {
      await query(
        'finance',
        'UPDATE contribution_requests SET status=$2,version=version+1 WHERE id=$1',
        [collection.id, requestStatus],
      );
      await bump(f.fundId);
      await check(requestContext, []);
      await check(ownerDueContext, []);
    }
    await query(
      'finance',
      "UPDATE contribution_requests SET status='OPEN',version=version+1 WHERE id=$1",
      [collection.id],
    );
    for (const [fundStatus, value] of [
      ['CLOSING', 2],
      ['CLOSED', 3],
    ]) {
      await query(
        'finance',
        'UPDATE funds SET status=$2,finance_version=finance_version+1 WHERE id=$1',
        [f.fundId, fundStatus],
      );
      await check(requestContext, [], null, value);
      await check(ownerDueContext, [], null, value);
    }
    await query(
      'finance',
      "UPDATE funds SET status='OPEN',finance_version=finance_version+1 WHERE id=$1",
      [f.fundId],
    );
    pass('Closed or cancelled requests and non-open Funds return an empty current context');

    const closureFund = await createFund();
    const hash = 'a'.repeat(64);
    const [closure] = await query(
      'finance',
      `INSERT INTO finance_closures(fund_id,requested_by_user_id,status,snapshot_finance_version,
        snapshot_schema_version,snapshot_json,snapshot_hash,requested_at)
       VALUES($1,$2,'PENDING_CONFIRMATIONS',7,1,$3::jsonb,$4,clock_timestamp()-interval '1 day') RETURNING id`,
      [closureFund.fundId, owner.id, JSON.stringify({ fixture: privateValues[4] }), hash],
    );
    for (const user of [owner, holder, member])
      await query(
        'finance',
        'INSERT INTO closure_confirmations(closure_id,user_id,snapshot_hash) VALUES($1,$2,$3)',
        [closure.id, user.id, hash],
      );
    await query('finance', "UPDATE funds SET status='CLOSING',finance_version=8 WHERE id=$1", [
      closureFund.fundId,
    ]);
    const closureContext = source(closureFund.fundId, 'CLOSURE', closure.id);
    await denied({ ...closureContext, fund_id: f.fundId }, status.NOT_FOUND);
    await check(closureContext, [owner, holder, member], null, 2);
    await query(
      'finance',
      'UPDATE closure_confirmations SET confirmed_at=clock_timestamp() WHERE closure_id=$1 AND user_id=$2',
      [closure.id, owner.id],
    );
    await bump(closureFund.fundId);
    await check(closureContext, [holder, member], null, 2);
    await join(closureFund.tripId, outsider);
    await check(closureContext, [holder, member], null, 2);
    await leave(closureFund.tripId, member);
    await check(closureContext, [holder], null, 2);
    await join(closureFund.tripId, member);
    await check(closureContext, [holder], null, 2);
    await query(
      'finance',
      'UPDATE closure_confirmations SET confirmed_at=clock_timestamp() WHERE closure_id=$1 AND user_id=$2',
      [closure.id, holder.id],
    );
    await bump(closureFund.fundId);
    await check(closureContext, [], null, 2);
    await query('finance', "UPDATE finance_closures SET status='CANCELLED' WHERE id=$1", [
      closure.id,
    ]);
    await query(
      'finance',
      "UPDATE funds SET status='OPEN',finance_version=finance_version+1 WHERE id=$1",
      [closureFund.fundId],
    );
    await check(closureContext, []);
    await query('finance', "UPDATE finance_closures SET status='COMPLETED' WHERE id=$1", [
      closure.id,
    ]);
    await query(
      'finance',
      "UPDATE funds SET status='CLOSED',finance_version=finance_version+1 WHERE id=$1",
      [closureFund.fundId],
    );
    await check(closureContext, [], null, 3);
    pass(
      'Closure context keeps its required unconfirmed cohort and excludes new or rejoined memberships',
    );

    await denied(ownerDueContext, status.DEADLINE_EXCEEDED, { deadlineMs: -1 });
    await whileTripStopped(async () => {
      await denied(ownerDueContext, status.UNAVAILABLE);
      await denied(requestContext, status.UNAVAILABLE);
    });
    await waitFor(async () => {
      await check(ownerDueContext, [owner], due);
      return true;
    });
    pass(
      'Automation context respects deadlines and fails closed on real Trip outage, then recovers',
    );
    pass(
      'Every context RPC preserves all 17 Finance business tables and returns only the minimal projection',
    );
    return { forbidden: privateValues };
  } finally {
    client.close();
  }
}
