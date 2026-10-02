import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import amqp from 'amqplib';
const require = createRequire(import.meta.url);
const { TripClient } = require('../apps/api-gateway/dist/trip-client.js');
const { TripAccessClient } = require('../packages/contracts/dist/trip-client.js');
const { TripOutboxService } = require('../apps/trip-workspace-service/dist/trip-outbox.service.js');
const {
  MembershipRepository,
} = require('../apps/trip-workspace-service/dist/membership/membership.repository.js');
const {
  LifecycleService,
} = require('../apps/trip-workspace-service/dist/operations/lifecycle.service.js');
const {
  LifecycleFinanceClient,
} = require('../apps/trip-workspace-service/dist/operations/lifecycle-finance.client.js');
const { PlanService } = require('../apps/trip-workspace-service/dist/planning/plan.service.js');
const { command } = require('../apps/trip-workspace-service/dist/membership/membership.domain.js');

export async function runMembershipTests(ctx) {
  const {
    request,
    query,
    account,
    bearer,
    waitFor,
    pass,
    ports,
    secrets,
    tripBody,
    financeFixture,
  } = ctx;
  const owner = await account('Lifecycle Owner'),
    member = await account('Lifecycle Member');
  const other = await account('Lifecycle Other'),
    admin = await account('Lifecycle Admin', 'ADMIN');
  const config = {
    get: (key) =>
      ({
        FINANCE_GRPC_TARGET: `127.0.0.1:${ctx.financePort}`,
        TRIP_FINANCE_SECRET: ctx.financeSecret,
        TRIP_MEMBERSHIP_LIFECYCLE_ENABLED: 'true',
        RABBITMQ_URL: ctx.brokerUrl(),
      })[key],
    getOrThrow(key) {
      return this.get(key);
    },
  };
  const pool = new pg.Pool({ connectionString: ctx.databaseUrl });
  const db = {
    query: (sql, args) => pool.query(sql, args),
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const repo = new MembershipRepository(db),
    finance = new LifecycleFinanceClient(config),
    service = new LifecycleService(repo, finance, config);
  const client = new TripClient(`127.0.0.1:${ports.tripGrpc}`, secrets.GATEWAY_TRIP_SECRET);
  const access = new TripAccessClient(
    `127.0.0.1:${ports.tripGrpc}`,
    'Finance',
    secrets.FINANCE_TRIP_SECRET,
  );
  const ok = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));
  const getTrip = async (id) => (await query('trip', 'SELECT * FROM trips WHERE id=$1', [id]))[0];
  async function setup(label = 'Lifecycle') {
    const created = await request('/api/v1/trips', 'POST', tripBody(label), bearer(owner));
    ok(created, 201);
    const trip = created.body.data;
    const m = (
      await query(
        'trip',
        "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp()) RETURNING *",
        [trip.id, member.id],
      )
    )[0];
    return { trip, m, path: `/api/v1/trips/${trip.id}` };
  }
  const leave = async (
    s,
    user = member,
    key = randomUUID(),
    expected = undefined,
    reason = 'Leaving',
  ) =>
    request(
      `${s.path}/leave`,
      'POST',
      {
        reason,
        expected_membership_revision: expected ?? (await getTrip(s.trip.id)).membership_revision,
      },
      { ...bearer(user), 'idempotency-key': key },
    );
  const remove = async (
    s,
    user = owner,
    target = s.m.id,
    key = randomUUID(),
    expected = undefined,
  ) =>
    request(
      `${s.path}/members/${target}`,
      'DELETE',
      {
        reason: 'Removing',
        expected_membership_revision: expected ?? (await getTrip(s.trip.id)).membership_revision,
      },
      { ...bearer(user), 'idempotency-key': key },
    );
  const grant = async (s) =>
    request(
      `${s.path}/plan-policy`,
      'PUT',
      {
        policy: 'SELECTED_MEMBERS',
        editor_member_ids: [s.m.id],
        expected_membership_revision: (await getTrip(s.trip.id)).membership_revision,
      },
      { ...bearer(owner), 'idempotency-key': randomUUID() },
    );
  const op = async (id) =>
    (await query('trip', 'SELECT * FROM trip_operations WHERE operation_id=$1', [id]))[0];
  async function recover(id) {
    await query(
      'trip',
      "UPDATE trip_operations SET next_retry_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY')",
      [id],
    );
    await service.recoverDue();
    return waitFor(async () => {
      const row = await op(id);
      return ['SUCCEEDED', 'FAILED'].includes(row.state) ? row : null;
    });
  }
  const input = (s, id, kind = 'LEAVE_MEMBER') => ({
    operation_id: id,
    actor_user_id: kind === 'LEAVE_MEMBER' ? member.id : owner.id,
    trip_id: s.trip.id,
    reason: 'Leaving',
    expected_membership_revision: 1,
    ...(kind === 'REMOVE_MEMBER' ? { member_id: s.m.id } : {}),
  });
  async function invite(s) {
    const result = await request(
      `${s.path}/invitations`,
      'POST',
      {
        invitation_type: 'LINK',
        expected_membership_revision: (await getTrip(s.trip.id)).membership_revision,
      },
      { ...bearer(owner), 'idempotency-key': randomUUID() },
    );
    ok(result, 201);
    return new URLSearchParams(new URL(result.body.data.one_time_link).hash.slice(1)).get('token');
  }
  const accept = (token, user = member, key = randomUUID()) =>
    request(
      '/api/v1/invitations/accept',
      'POST',
      { token },
      { ...bearer(user), 'idempotency-key': key },
    );
  try {
    const s = await setup();
    ok(await grant(s), 200);
    await query(
      'trip',
      `INSERT INTO packing_items(trip_id,name,assigned_member_id,status,completed_by_user_id,completed_at,created_by_user_id)
      VALUES($1,'Completed kit',$2,'COMPLETED',$3,clock_timestamp(),$3)`,
      [s.trip.id, s.m.id, member.id],
    );
    const activity = await request(
      `${s.path}/activities`,
      'POST',
      {
        title: 'Historical activity',
        activity_type: 'OTHER',
        position: 0,
        expected_plan_version: 1,
      },
      { ...bearer(member), 'idempotency-key': randomUUID() },
    );
    ok(activity, 201);
    const before = await getTrip(s.trip.id),
      id = randomUUID();
    const ended = await leave(s, member, id, before.membership_revision);
    ok(ended, 200);
    assert.deepEqual(Object.keys(ended.body.data).sort(), [
      'operation_id',
      'outcome',
      'state',
      'trip_id',
    ]);
    assert.equal(ended.body.data.state, 'SUCCEEDED');
    const after = await getTrip(s.trip.id);
    assert.equal(after.membership_revision, before.membership_revision + 1);
    assert.equal(after.export_revision, before.export_revision + 1);
    assert.equal(after.plan_version, before.plan_version + 1);
    const item = (
      await query('trip', 'SELECT * FROM packing_items WHERE trip_id=$1', [s.trip.id])
    )[0];
    assert.equal(item.status, 'TODO');
    assert.equal(item.assigned_member_id, null);
    assert.equal(item.completed_by_user_id, null);
    assert.equal(item.completed_at, null);
    assert.equal(
      (await query('trip', 'SELECT * FROM trip_plan_editors WHERE trip_id=$1', [s.trip.id])).length,
      0,
    );
    assert.equal(
      (
        await query('trip', 'SELECT created_by_user_id FROM activities WHERE trip_id=$1', [
          s.trip.id,
        ])
      )[0].created_by_user_id,
      member.id,
    );
    const audit = (
      await query(
        'trip',
        "SELECT * FROM trip_audit_logs WHERE trip_id=$1 AND action='MEMBER_LEFT'",
        [s.trip.id],
      )
    )[0];
    assert.equal(audit.details.packing_before[0].completed_by_user_id, member.id);
    for (const suffix of ['', '/members', '/plan'])
      ok(await request(s.path + suffix, 'GET', undefined, bearer(member)), 404);
    await assert.rejects(() =>
      access.getAccessContext(
        { trip_id: s.trip.id, user_id: member.id, action: 'PLAN_EDIT' },
        randomUUID(),
      ),
    );
    ok(
      await request(
        `${s.path}/activities`,
        'POST',
        {
          title: 'Denied',
          activity_type: 'OTHER',
          position: 0,
          expected_plan_version: after.plan_version,
        },
        { ...bearer(member), 'idempotency-key': randomUUID() },
      ),
      404,
    );
    assert.equal(
      (
        await query(
          'trip',
          "SELECT * FROM outbox_events WHERE operation_id=$1 AND event_type IN ('MemberLeft','PlanUpdated')",
          [id],
        )
      ).length,
      2,
    );
    pass(
      'leave atomically revokes read/Plan/editor; resets packing; preserves activity and audit history',
    );

    const counts = async () =>
      (
        await query(
          'trip',
          'SELECT (SELECT count(*) FROM trip_audit_logs WHERE trip_id=$1) AS audits,(SELECT count(*) FROM outbox_events WHERE trip_id=$1) AS events',
          [s.trip.id],
        )
      )[0];
    const countBefore = await counts();
    ok(await leave(s, member, id, before.membership_revision), 200);
    assert.deepEqual(await counts(), countBefore);
    ok(await leave(s, member, id, before.membership_revision, 'Changed'), 409);
    ok(await leave(s), 404);
    ok(await request(`/api/v1/operations/${id}`, 'GET', undefined, bearer(member)), 200);
    ok(await request(`/api/v1/operations/${id}`, 'GET', undefined, bearer(owner)), 404);
    ok(await request(`/api/v1/operations/${id}`, 'GET', undefined, bearer(admin)), 404);
    pass(
      'historical leave replay/poll after losing membership; changed hash conflicts; no extra effects',
    );

    const r = await setup('Removal');
    ok(await remove(r, member), 403);
    ok(await remove(r, other), 404);
    ok(await remove(r, admin), 404);
    ok(await leave(r, owner), 409);
    const ownerMembership = (
      await query('trip', "SELECT id FROM trip_members WHERE trip_id=$1 AND role='OWNER'", [
        r.trip.id,
      ])
    )[0].id;
    ok(await remove(r, owner, ownerMembership), 409);
    ok(await remove(r, owner, s.m.id), 404);
    ok(await remove(r, owner, randomUUID()), 404);
    const spoof = await request(
      `${r.path}/members/${r.m.id}`,
      'DELETE',
      { reason: 'Spoof', expected_membership_revision: 1 },
      {
        ...bearer(member),
        'idempotency-key': randomUUID(),
        'x-user-id': owner.id,
        'x-system-role': 'ADMIN',
      },
    );
    ok(spoof, 403);
    ok(
      await request(
        `${r.path}/leave`,
        'POST',
        { reason: 'Spoof', expected_membership_revision: 1, actor_user_id: owner.id },
        { ...bearer(member), 'idempotency-key': randomUUID() },
      ),
      400,
    );
    const rid = randomUUID();
    ok(await remove(r, owner, r.m.id, rid, 1), 200);
    assert.equal((await getTrip(r.trip.id)).plan_version, 1);
    ok(await remove(r, owner, r.m.id, rid, 1), 200);
    ok(await remove(r), 409);
    ok(await remove(r, owner, r.m.id, randomUUID(), 1), 409);
    assert.equal(
      (
        await query(
          'trip',
          "SELECT * FROM trip_members WHERE trip_id=$1 AND role='OWNER' AND left_at IS NULL",
          [r.trip.id],
        )
      ).length,
      1,
    );
    pass(
      'Owner removal, cross-Trip targets, stale revisions, actor spoofing and last-Owner invariant',
    );

    const list = await request(
      `${s.path}/members?include_left=true&limit=1`,
      'GET',
      undefined,
      bearer(owner),
    );
    ok(list, 200);
    assert.equal(list.body.data.items.length, 1);
    assert.ok(list.body.data.next_cursor);
    ok(
      await request(
        `${s.path}/members?include_left=true&limit=1&cursor=${list.body.data.next_cursor}`,
        'GET',
        undefined,
        bearer(owner),
      ),
      200,
    );
    ok(
      await request(
        `${s.path}/members?cursor=${list.body.data.next_cursor}`,
        'GET',
        undefined,
        bearer(owner),
      ),
      400,
    );
    assert.equal(
      (await request(`${s.path}/members`, 'GET', undefined, bearer(owner))).body.data.items.length,
      1,
    );
    for (const field of ['archived_at', 'deleted_at']) {
      const state = await setup(field);
      await query('trip', `UPDATE trips SET ${field}=clock_timestamp() WHERE id=$1`, [
        state.trip.id,
      ]);
      ok(await leave(state), field === 'deleted_at' ? 404 : 409);
    }
    const closed = await setup('Closure');
    await query('trip', 'UPDATE trips SET closure_lock_id=$2 WHERE id=$1', [
      closed.trip.id,
      randomUUID(),
    ]);
    ok(await leave(closed), 409);
    pass('membership listing, bound pagination, archive/deleted/closure states');

    const rejoin = await setup('Rejoin');
    const old = await invite(rejoin);
    ok(await grant(rejoin), 200);
    const oldRevision = (await getTrip(rejoin.trip.id)).membership_revision;
    const leaveKey = randomUUID();
    ok(await leave(rejoin, member, leaveKey, oldRevision), 200);
    ok(await accept(old), 409);
    ok(await accept(old, other), 200);
    const newer = await invite(rejoin),
      acceptKey = randomUUID();
    const joined = await accept(newer, member, acceptKey);
    ok(joined, 200);
    const newId = joined.body.data.membership.id;
    assert.notEqual(newId, rejoin.m.id);
    ok(await leave(rejoin, member, leaveKey, oldRevision), 200);
    assert.equal(
      (await query('trip', 'SELECT left_at FROM trip_members WHERE id=$1', [newId]))[0].left_at,
      null,
    );
    const current = await access.getAccessContext(
      { trip_id: rejoin.trip.id, user_id: member.id, action: 'PLAN_EDIT' },
      randomUUID(),
    );
    assert.equal(current.context.can_edit_plan, false);
    ok(await remove(rejoin), 409);
    ok(await remove(rejoin, owner, newId), 200);
    ok(await accept(newer, member, acceptKey), 404);
    pass(
      'old invitation cutoff, LINK for another user, new membership and no restored editor/accept replay',
    );

    const reject = await setup('Finance rejected');
    financeFixture.modes.set(reject.trip.id, 'reject');
    const blocked = await leave(reject);
    ok(blocked, 409);
    assert.equal(blocked.body.error.code, 'FINANCE_OBLIGATION_BLOCKED');
    assert.equal((await getTrip(reject.trip.id)).membership_revision, 1);
    assert.equal(
      (await query('trip', 'SELECT left_at FROM trip_members WHERE id=$1', [reject.m.id]))[0]
        .left_at,
      null,
    );
    for (const mode of ['lost-response', 'unavailable']) {
      const lost = await setup(mode),
        key = randomUUID();
      financeFixture.modes.set(lost.trip.id, mode);
      ok(await leave(lost, member, key, 1), 202);
      assert.equal(
        (await query('trip', 'SELECT left_at FROM trip_members WHERE id=$1', [lost.m.id]))[0]
          .left_at,
        null,
      );
      const recovered = await recover(key);
      assert.equal(recovered.state, mode === 'lost-response' ? 'SUCCEEDED' : 'FAILED');
      if (mode === 'unavailable') {
        financeFixture.modes.delete(lost.trip.id);
        const original = financeFixture.calls.find(
          (c) => c.method === 'execute' && c.request.operation_id === key,
        ).request;
        assert.equal((await financeFixture.lateExecute(original)).outcome.status, 3);
      }
    }
    pass(
      'Finance reject, lost response recovery and NOT_FOUND cancellation wins over late Execute (fixture)',
    );

    const executeWins = await setup('Execute wins cancel'),
      executeKey = randomUUID();
    const executePrepared = await repo.prepare(
      command(input(executeWins, executeKey), 'LEAVE_MEMBER'),
      randomUUID(),
      true,
    );
    const staleNotFound = financeFixture.holdNotFound();
    const recovering = finance.recover(executePrepared.row, Date.now() + 6000);
    await staleNotFound.reached;
    await finance.execute(executePrepared.row, Date.now() + 1800);
    staleNotFound.release();
    const winner = await recovering;
    assert.equal(winner.outcome.status, 1);
    await repo.finish(executeKey, winner.outcome);
    assert.equal((await op(executeKey)).state, 'SUCCEEDED');
    pass('stale NOT_FOUND then Execute wins: Cancel returns COMMITTED, never a false cancellation');

    for (const kind of ['leave/remove', 'double-remove', 'grant/remove', 'accept/remove']) {
      const race = await setup(kind),
        key = randomUUID();
      const invitation = kind === 'accept/remove' ? await invite(race) : undefined;
      const hold = financeFixture.holdNext();
      const first =
        kind === 'leave/remove'
          ? leave(race, member, key, 1)
          : remove(race, owner, race.m.id, key, 1);
      await hold.reached;
      if (kind === 'grant/remove') ok(await grant(race), 200);
      else if (kind === 'accept/remove') ok(await accept(invitation, other), 409);
      else ok(await remove(race), 409);
      hold.release();
      ok(await first, 200);
      assert.equal(
        (await query('trip', 'SELECT * FROM trip_plan_editors WHERE trip_id=$1', [race.trip.id]))
          .length,
        0,
      );
      assert.equal(
        (
          await query(
            'trip',
            "SELECT * FROM outbox_events WHERE trip_id=$1 AND event_type IN ('MemberLeft','MemberRemoved')",
            [race.trip.id],
          )
        ).length,
        1,
      );
    }
    pass('guard races leave/remove, double-remove, grant/remove and accept/remove');

    // Inject failures into mandatory writes. Finance has committed; T2 must rollback,
    // leaving the guard until a later recovery can complete atomically.
    for (const table of ['trip_audit_logs', 'outbox_events', 'trip_operations']) {
      const fault = await setup(`fault ${table}`),
        key = randomUUID();
      const trigger = `lifecycle_fault_${table}`;
      await query(
        'trip',
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.trip_id='${fault.trip.id}'::uuid ${table === 'trip_operations' ? "AND NEW.state='SUCCEEDED'" : ''} THEN RAISE EXCEPTION 'test lifecycle write failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER ${trigger} BEFORE ${table === 'trip_operations' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        ok(await leave(fault, member, key, 1), 202);
        assert.equal((await getTrip(fault.trip.id)).membership_revision, 1);
        assert.equal(
          (await query('trip', 'SELECT left_at FROM trip_members WHERE id=$1', [fault.m.id]))[0]
            .left_at,
          null,
        );
        assert.equal(
          (await query('trip', 'SELECT * FROM outbox_events WHERE operation_id=$1', [key])).length,
          0,
        );
      } finally {
        await query('trip', `DROP TRIGGER ${trigger} ON ${table}; DROP FUNCTION ${trigger}()`);
      }
      assert.equal((await recover(key)).state, 'SUCCEEDED');
    }
    pass(
      'audit/outbox/terminal receipt failure rolls back all Trip effects; committed Finance recovers forward',
    );

    // Prove a running Plan mutation that acquired Trip first commits before departure.
    const running = await setup('Plan first');
    ok(await grant(running), 200);
    const plan = new PlanService(db);
    let signal, release;
    const entered = new Promise((r) => {
        signal = r;
      }),
      proceed = new Promise((r) => {
        release = r;
      });
    const real = db.withTransaction;
    const blockingDb = {
      ...db,
      withTransaction: (fn) =>
        real(async (tx) => {
          const wrapped = {
            query: async (sql, args) => {
              const result = await tx.query(sql, args);
              if (sql === 'SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE') {
                signal((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
                await proceed;
              }
              return result;
            },
          };
          return fn(wrapped);
        }),
    };
    const activeWrite = new PlanService(blockingDb).createActivity({
      operationId: randomUUID(),
      actorUserId: member.id,
      tripId: running.trip.id,
      expectedPlanVersion: 1,
      correlationId: randomUUID(),
      fields: { title: 'Before revoke', activity_type: 'OTHER', position: 0 },
    });
    const pid = await entered;
    const removal = remove(running);
    await waitFor(
      async () =>
        (
          await query(
            'trip',
            'SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
            [pid],
          )
        ).length,
    );
    release();
    await activeWrite;
    ok(await removal, 200);
    await assert.rejects(
      () =>
        plan.createActivity({
          operationId: randomUUID(),
          actorUserId: member.id,
          tripId: running.trip.id,
          expectedPlanVersion: 2,
          correlationId: randomUUID(),
          fields: { title: 'After revoke', activity_type: 'OTHER', position: 0 },
        }),
      /RESOURCE_NOT_FOUND/,
    );
    pass(
      'real PostgreSQL lock wait orders in-flight Plan before revoke; post-commit Plan is denied',
    );

    const revoking = await setup('Revoke first');
    ok(await grant(revoking), 200);
    let revokeSignal, revokeRelease;
    const revokeEntered = new Promise((r) => {
        revokeSignal = r;
      }),
      revokeProceed = new Promise((r) => {
        revokeRelease = r;
      });
    const revokeDb = {
      ...db,
      withTransaction: (fn) =>
        real(async (tx) =>
          fn({
            query: async (sql, args) => {
              const result = await tx.query(sql, args);
              if (sql.startsWith('UPDATE trip_members SET left_at=')) {
                revokeSignal((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
                await revokeProceed;
              }
              return result;
            },
          }),
        ),
    };
    const revokeService = new LifecycleService(new MembershipRepository(revokeDb), finance, config);
    const revokeWrite = revokeService.execute(
      { ...input(revoking, randomUUID()), expected_membership_revision: 2 },
      'LEAVE_MEMBER',
      randomUUID(),
      Date.now() + 1800,
    );
    const revokePid = await revokeEntered;
    const waitingWrite = request(
      `${revoking.path}/activities`,
      'POST',
      {
        title: 'Must be denied after waiting',
        activity_type: 'OTHER',
        position: 0,
        expected_plan_version: 1,
      },
      { ...bearer(member), 'idempotency-key': randomUUID() },
    );
    await waitFor(
      async () =>
        (
          await query(
            'trip',
            'SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
            [revokePid],
          )
        ).length,
    );
    revokeRelease();
    await revokeWrite;
    ok(await waitingWrite, 404);
    pass('revoke-first real lock wait forces fresh authorization in the actual Plan endpoint');

    // Simulate process loss at the boundary: durable T1 and Finance COMMITTED,
    // no T2 on the original service; a new instance completes it, even disabled.
    const crash = await setup('Crash boundary'),
      crashKey = randomUUID();
    const crashPrepared = await repo.prepare(
      command(input(crash, crashKey), 'LEAVE_MEMBER'),
      randomUUID(),
      true,
    );
    await finance.execute(crashPrepared.row, Date.now() + 1800);
    await query(
      'trip',
      "UPDATE trip_operations SET next_retry_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
      [crashKey],
    );
    const restarted = new LifecycleService(new MembershipRepository(db), finance, {
      get: () => 'false',
    });
    await Promise.all([restarted.recoverDue(), service.recoverDue()]);
    await waitFor(async () => (await op(crashKey)).state === 'SUCCEEDED');
    assert.equal((await op(crashKey)).state, 'SUCCEEDED');
    assert.equal(
      (await query('trip', 'SELECT * FROM outbox_events WHERE operation_id=$1', [crashKey])).length,
      1,
    );
    pass(
      'new service instance/two workers recover committed Finance exactly once while new writes are disabled',
    );

    const review = await setup('Needs review'),
      reviewKey = randomUUID();
    await repo.prepare(command(input(review, reviewKey), 'LEAVE_MEMBER'), randomUUID(), true);
    const offline = new LifecycleService(
      repo,
      {
        recover: async () => {
          throw new Error('offline');
        },
      },
      config,
    );
    // Suspend only the isolated Trip child so automatic worker timing cannot race
    // this deliberately offline worker. Real restart happens on leaving the block.
    await ctx.whileTripStopped(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await query(
          'trip',
          "UPDATE trip_operations SET next_retry_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
          [reviewKey],
        );
        await offline.recoverDue();
      }
      assert.equal((await op(reviewKey)).state, 'NEEDS_REVIEW');
      await assert.rejects(
        () =>
          service.execute(
            input(review, randomUUID(), 'REMOVE_MEMBER'),
            'REMOVE_MEMBER',
            randomUUID(),
            Date.now() + 1800,
          ),
        /STATE_CONFLICT/,
      );
      assert.equal((await service.retryNeedsReview(reviewKey, false)).state, 5);
      assert.equal((await op(reviewKey)).state, 'NEEDS_REVIEW');
      await service.retryNeedsReview(reviewKey, true);
      assert.equal((await recover(reviewKey)).state, 'FAILED'); // NOT_FOUND -> durable CANCELLED.
    });
    pass(
      'five failed recovery attempts retain guard in NEEDS_REVIEW; dry-run is read-only; same-ID retry cancels safely',
    );

    await waitFor(
      async () => (await request('/api/v1/trips', 'GET', undefined, bearer(owner))).status === 200,
    );
    const processCrash = await setup('Trip process crash'),
      processKey = randomUUID();
    const preparedCrash = await repo.prepare(
      command(input(processCrash, processKey), 'LEAVE_MEMBER'),
      randomUUID(),
      true,
    );
    await finance.execute(preparedCrash.row, Date.now() + 1800);
    await ctx.whileTripStopped(async () => {
      await query(
        'trip',
        "UPDATE trip_operations SET next_retry_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
        [processKey],
      );
      assert.equal((await op(processKey)).state, 'PROCESSING');
    });
    await waitFor(async () => (await op(processKey)).state === 'SUCCEEDED');
    assert.equal(
      (await query('trip', 'SELECT * FROM outbox_events WHERE operation_id=$1', [processKey]))
        .length,
      1,
    );
    pass(
      'abrupt Trip child restart recovers persisted Finance COMMITTED boundary through the real background worker',
    );

    const invalidReceipt = await setup('Invalid receipt'),
      invalidKey = randomUUID();
    const invalidService = new LifecycleService(
      repo,
      {
        execute: async (row) => ({
          operation_id: row.operation_id,
          request_hash: 'wrong',
          outcome: { status: 1 },
          completed_at: { seconds: '1', nanos: 0 },
        }),
      },
      config,
    );
    const invalidResult = await invalidService.execute(
      input(invalidReceipt, invalidKey),
      'LEAVE_MEMBER',
      randomUUID(),
      Date.now() + 1800,
    );
    assert.equal(invalidResult.state, 2);
    assert.equal((await getTrip(invalidReceipt.trip.id)).membership_revision, 1);
    assert.equal((await recover(invalidKey)).state, 'FAILED');
    pass(
      'malformed Finance receipt never finalizes membership and is recovered through authoritative protocol',
    );

    const bad = new TripClient(`127.0.0.1:${ports.tripGrpc}`, 'wrong-secret');
    try {
      await assert.rejects(
        () =>
          bad.call('ListMembers', { trip_id: s.trip.id, actor_user_id: owner.id }, randomUUID()),
        (e) => e.code === 7,
      );
    } finally {
      bad.close();
    }
    const disabled = new LifecycleService(repo, finance, { get: () => 'false' });
    const disabledTrip = await setup('Disabled');
    await assert.rejects(
      () =>
        disabled.execute(
          input(disabledTrip, randomUUID()),
          'LEAVE_MEMBER',
          randomUUID(),
          Date.now() + 1800,
        ),
      /SERVICE_UNAVAILABLE/,
    );
    assert.equal(
      (
        await query(
          'trip',
          "SELECT * FROM trip_operations WHERE trip_id=$1 AND operation_type='LEAVE_MEMBER'",
          [disabledTrip.trip.id],
        )
      ).length,
      0,
    );
    const replayDisabled = await disabled.execute(
      { ...input(s, id), expected_membership_revision: before.membership_revision },
      'LEAVE_MEMBER',
      randomUUID(),
      Date.now() + 1800,
    );
    assert.equal(replayDisabled.state, 3);
    pass(
      'wrong service secret rejected; disabled flag blocks new intent but preserves safe replay',
    );

    // Publisher test uses an isolated catch-all queue, NOT the account-email handler.
    const broker = await amqp.connect(ctx.brokerUrl()),
      channel = await broker.createChannel();
    const publisher = new TripOutboxService(db, config);
    try {
      await channel.assertExchange('wolfari.events.v1', 'topic', { durable: true });
      const queue = await channel.assertQueue('', { exclusive: true });
      await channel.bindQueue(queue.queue, 'wolfari.events.v1', '#');
      for (let batch = 0; batch < 30; batch++) await publisher.tick();
      const messages = [];
      for (;;) {
        const message = await channel.get(queue.queue, { noAck: true });
        if (!message) break;
        messages.push(JSON.parse(message.content.toString()));
      }
      assert.ok(messages.some((e) => e.event_type === 'MemberLeft'));
      assert.ok(messages.some((e) => e.event_type === 'MemberRemoved'));
      const published = messages.find((e) => e.event_type === 'MemberLeft');
      assert.deepEqual(Object.keys(published.payload).sort(), [
        'membership_revision',
        'trip_id',
        'user_id',
      ]);
      assert.ok(published.aggregate_id);
      assert.equal(published.aggregate_type, 'Membership');
    } finally {
      await publisher.onApplicationShutdown();
      await channel.close();
      await broker.close();
    }
    pass(
      'MemberLeft/Removed outbox publishes to isolated RabbitMQ capture queue; no consumer E2E claim',
    );
  } finally {
    client.close();
    access.close();
    finance.onApplicationShutdown();
    await pool.end();
  }
}
