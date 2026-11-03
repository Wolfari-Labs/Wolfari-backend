import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Real Gateway, five accounts, no SQL business setup. SQL below is read-only proof. */
export async function runDemo1Acceptance({
  request,
  account,
  bearer,
  waitFor,
  pass,
  infra,
  query,
  restartTrip,
  stopFinance,
}) {
  const expected = (response, status) => {
    // Do not serialize bodies: auth/invitation responses contain secrets.
    assert.equal(
      response.status,
      status,
      `Unexpected HTTP status; code=${response.body?.error?.code ?? 'none'}`,
    );
    return response.body.data;
  };
  const get = async (path, actor) =>
    expected(await request(path, 'GET', undefined, bearer(actor)), 200);
  const write = async (path, body, actor, method = 'POST', key = randomUUID(), status = 200) => {
    const invoke = () => request(path, method, body, { ...bearer(actor), 'idempotency-key': key });
    let response = await invoke();
    if (response.status === 202) {
      await waitFor(async () => {
        const operation = await get('/api/v1/operations/' + key, actor);
        assert.notEqual(operation.state, 'FAILED', 'Operation failed');
        assert.notEqual(operation.state, 'NEEDS_REVIEW', 'Operation needs review');
        return operation.state === 'SUCCEEDED';
      }, 45000);
      response = await invoke();
    }
    return expected(response, status);
  };
  const mail = async (email, subject) =>
    waitFor(async () => {
      const response = await fetch(
        `http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/messages?limit=500`,
      );
      const list = await response.json();
      const item = list.messages.find(
        (value) => value.Subject.includes(subject) && value.To?.some((to) => to.Address === email),
      );
      if (!item) return null;
      return (
        await (
          await fetch(`http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/message/${item.ID}`)
        ).json()
      ).Text;
    }, 45000);
  const users = {};
  for (const role of ['owner', 'holder', 'editor', 'member', 'outsider']) {
    const user = await account('Demo1 ' + role);
    const text = await mail(user.email, 'Xác minh');
    const link = new URL(text.match(/https?:\/\/\S+/)[0]);
    expected(
      await request(
        '/api/v1/auth/email-verifications/confirm',
        'POST',
        { token: link.searchParams.get('token') },
        { 'x-client-type': 'mobile' },
      ),
      200,
    );
    users[role] = user;
  }
  const { owner, holder, editor, member, outsider } = users;
  pass('Demo1: five new accounts verified via RabbitMQ/Automation/Mailpit (no SQL verification)');
  expected(await request('/health/dependencies'), 200);
  const createBody = {
    name: 'Demo1 acceptance',
    start_at: '2026-10-31T17:00:00Z',
    end_at: '2026-11-03T17:00:00Z',
    timezone: 'Asia/Ho_Chi_Minh',
    client_request_id: randomUUID(),
  };
  const trip = await write(
    '/api/v1/trips',
    createBody,
    owner,
    'POST',
    createBody.client_request_id,
    201,
  );
  const root = '/api/v1/trips/' + trip.id;
  const tripRead = () => get(root, owner);
  for (const user of [holder, editor, member]) {
    const email = user === holder;
    const invite = await write(
      root + '/invitations',
      {
        invitation_type: email ? 'EMAIL' : 'LINK',
        ...(email ? { email: user.email } : {}),
        expected_membership_revision: (await tripRead()).membership_revision,
      },
      owner,
      'POST',
      randomUUID(),
      201,
    );
    const link = email
      ? (await mail(user.email, 'Lời mời')).match(/https?:\/\/\S+/)[0]
      : invite.one_time_link;
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    await write('/api/v1/invitations/accept', { token }, user);
  }
  const members = (await get(root + '/members', owner)).items;
  assert.equal(members.length, 4);
  for (const item of members) assert.match(item.display_name, /^Demo1 /);
  const editorId = members.find((item) => item.user_id === editor.id).id;
  await write(
    root + '/plan-policy',
    {
      policy: 'SELECTED_MEMBERS',
      editor_member_ids: [editorId],
      expected_membership_revision: (await tripRead()).membership_revision,
    },
    owner,
    'PUT',
  );
  assert.deepEqual((await get(root + '/plan-policy', owner)).editor_member_ids, [editorId]);
  expected(await request(root + '/plan-policy', 'GET', undefined, bearer(member)), 403);
  expected(await request(root + '/plan-policy', 'GET', undefined, bearer(outsider)), 404);
  pass('Demo1: EMAIL/LINK accept, named members, Owner-only policy read and selected Editor');

  const plan = (user = owner) => get(root + '/plan', user);
  const draft = {
    title: 'Day only',
    activity_type: 'OTHER',
    position: 0,
    scheduled_date: '2026-11-01',
    expected_plan_version: (await plan()).plan_version,
  };
  const createKey = randomUUID();
  let activity = await write(root + '/activities', draft, editor, 'POST', createKey, 201);
  assert.equal(activity.scheduled_date, '2026-11-01');
  assert.deepEqual(
    await write(root + '/activities', draft, editor, 'POST', createKey, 201),
    activity,
  );
  const activityPath = root + '/activities/' + activity.id;
  activity = await write(
    activityPath,
    { title: 'Old client edits title', expected_plan_version: activity.plan_version },
    editor,
    'PATCH',
  );
  assert.equal(activity.scheduled_date, '2026-11-01');
  activity = await write(
    activityPath,
    {
      starts_at: '2026-11-01T23:00:00+07:00',
      ends_at: '2026-11-02T01:00:00+07:00',
      expected_plan_version: activity.plan_version,
    },
    editor,
    'PATCH',
  );
  assert.equal(activity.scheduled_date, null);
  assert.equal(activity.ends_at, '2026-11-01T18:00:00.000Z');
  activity = await write(
    activityPath,
    {
      starts_at: null,
      ends_at: null,
      scheduled_date: '2026-11-03',
      expected_plan_version: activity.plan_version,
    },
    editor,
    'PATCH',
  );
  for (const scheduled_date of ['2026-11-04', '2026-10-31', '2026-02-30']) {
    expected(
      await request(
        activityPath,
        'PATCH',
        { scheduled_date, expected_plan_version: activity.plan_version },
        { ...bearer(editor), 'idempotency-key': randomUUID() },
      ),
      400,
    );
  }
  expected(
    await request(
      activityPath,
      'PATCH',
      { title: 'No permission', expected_plan_version: activity.plan_version },
      { ...bearer(member), 'idempotency-key': randomUUID() },
    ),
    403,
  );
  activity = await write(
    activityPath + '/completion',
    { status: 'COMPLETED', expected_plan_version: activity.plan_version },
    member,
    'PATCH',
  );
  activity = await write(
    activityPath + '/completion',
    { status: 'TODO', expected_plan_version: activity.plan_version },
    member,
    'PATCH',
  );
  const snapshots = await Promise.all([owner, holder, editor, member].map(plan));
  for (const snapshot of snapshots)
    assert.equal(snapshot.activities[0].scheduled_date, '2026-11-03');
  expected(await request(root + '/plan', 'GET', undefined, bearer(outsider)), 404);
  pass(
    'Demo1: day-only/old-client patch/overnight/clear/range/permissions/replay survive independent reads',
  );

  // The saved receipt remains replayable after later edits; it must not rewind storage.
  assert.equal(
    (await write(root + '/activities', draft, editor, 'POST', createKey, 201)).scheduled_date,
    '2026-11-01',
  );
  assert.equal((await plan()).activities[0].scheduled_date, '2026-11-03');
  expected(
    await request(
      activityPath,
      'PATCH',
      {
        scheduled_date: '2026-11-01',
        starts_at: '2026-11-01T12:00:00+07:00',
        ends_at: '2026-11-01T13:00:00+07:00',
        expected_plan_version: activity.plan_version,
      },
      { ...bearer(editor), 'idempotency-key': randomUUID() },
    ),
    400,
  );
  assert.equal((await plan()).plan_version, activity.plan_version);
  activity = await write(
    activityPath,
    { scheduled_date: null, expected_plan_version: activity.plan_version },
    editor,
    'PATCH',
  );
  assert.equal(activity.scheduled_date, null);
  activity = await write(
    activityPath,
    { scheduled_date: '2026-11-03', expected_plan_version: activity.plan_version },
    editor,
    'PATCH',
  );
  for (const example of [
    {
      timezone: 'America/New_York',
      start_at: '2027-03-14T05:00:00Z',
      end_at: '2027-03-15T04:00:00Z',
      day: '2027-03-14',
      invalid: '2027-03-15',
    },
    {
      timezone: 'Asia/Ho_Chi_Minh',
      start_at: '2026-12-31T16:30:00Z',
      end_at: '2026-12-31T18:00:00Z',
      day: '2027-01-01',
      invalid: '2027-01-02',
    },
    {
      timezone: 'Pacific/Apia',
      start_at: '2011-12-29T10:00:00Z',
      end_at: '2011-12-31T10:00:00Z',
      day: '2011-12-31',
      invalid: '2011-12-30',
    },
  ]) {
    const body = {
      name: 'Demo1 calendar boundary',
      start_at: example.start_at,
      end_at: example.end_at,
      timezone: example.timezone,
      client_request_id: randomUUID(),
    };
    const calendarTrip = await write(
      '/api/v1/trips',
      body,
      owner,
      'POST',
      body.client_request_id,
      201,
    );
    const path = '/api/v1/trips/' + calendarTrip.id + '/activities';
    const input = {
      title: 'Calendar boundary',
      activity_type: 'OTHER',
      position: 0,
      scheduled_date: example.day,
      expected_plan_version: calendarTrip.plan_version,
    };
    const saved = await write(path, input, owner, 'POST', randomUUID(), 201);
    assert.equal(saved.scheduled_date, example.day);
    expected(
      await request(
        path,
        'POST',
        { ...input, scheduled_date: example.invalid, expected_plan_version: saved.plan_version },
        { ...bearer(owner), 'idempotency-key': randomUUID() },
      ),
      400,
    );
    assert.equal(
      (await get('/api/v1/trips/' + calendarTrip.id + '/plan', owner)).activities.length,
      1,
    );
  }
  pass(
    'Demo1: old receipt after edits, explicit clear/conflict rollback, DST, year boundary and skipped local day',
  );

  const fund = await write(
    root + '/fund',
    {
      holder_user_id: holder.id,
      currency: 'VND',
      destination: {
        destination_type: 'VIETQR',
        bank_code: 'TEST',
        account_number: '000987654321',
        account_name: 'TEST ONLY - NOT REAL MONEY',
        active: true,
        is_default: true,
      },
    },
    owner,
    'POST',
    randomUUID(),
    201,
  );
  const fundRoot = '/api/v1/funds/' + fund.id;
  const readFund = (user = owner) => get(root + '/fund', user);
  const destination = (await get(fundRoot + '/destinations', owner))[0];
  await write(
    fundRoot + '/budget',
    { budget_amount: '1000000', expected_finance_version: (await readFund()).finance_version },
    owner,
    'PATCH',
  );
  assert.equal((await readFund()).current_balance, '0');
  await write(
    fundRoot + '/destinations/' + destination.id + '/confirm',
    {
      expected_version: destination.version,
      expected_finance_version: (await readFund()).finance_version,
    },
    holder,
  );
  const batch = await write(
    fundRoot + '/contribution-requests',
    {
      title: 'Demo1 manual round',
      contributions: [
        { member_user_id: editor.id, amount: '200000', destination_id: destination.id },
        { member_user_id: member.id, amount: '300000', destination_id: destination.id },
      ],
      expected_finance_version: (await readFund()).finance_version,
    },
    owner,
    'POST',
    randomUUID(),
    201,
  );
  const contribution = async (id, user) =>
    (await get(fundRoot + '/contributions?limit=100', user)).items.find((item) => item.id === id);
  for (const user of [editor, member]) {
    const id = batch.contributions.find((item) => item.member_user_id === user.id).id;
    const path = '/api/v1/contributions/' + id;
    const versions = async () => ({
      expected_version: (await contribution(id, user)).version,
      expected_finance_version: (await readFund()).finance_version,
    });
    const before = (await readFund()).current_balance;
    await write(path + '/report-transfer', await versions(), user);
    assert.equal((await readFund()).current_balance, before);
    if (user === editor) {
      await write(
        path + '/reject-transfer',
        { ...(await versions()), reason: 'TEST not received yet' },
        holder,
      );
      assert.equal((await readFund()).current_balance, before);
      assert.equal((await contribution(id, user)).rejected_reason, 'TEST not received yet');
      await write(path + '/report-transfer', await versions(), user);
      assert.equal((await contribution(id, user)).rejected_reason, 'TEST not received yet');
    }
    const payload = await versions(),
      key = randomUUID();
    await write(path + '/confirm-received', payload, holder, 'POST', key);
    await write(path + '/confirm-received', payload, holder, 'POST', key);
  }
  for (const user of [owner, holder, editor, member])
    assert.equal((await readFund(user)).current_balance, '500000');
  const ledger = await get(fundRoot + '/transactions?limit=1', owner);
  assert.equal(ledger.items.length, 1);
  assert.ok(ledger.next_cursor);
  const next = await get(
    fundRoot + '/transactions?limit=1&cursor=' + encodeURIComponent(ledger.next_cursor),
    member,
  );
  assert.equal(next.items.length, 1);
  assert.notEqual(ledger.items[0].id, next.items[0].id);
  const rows = await query(
    'finance',
    'SELECT amount::text FROM fund_transactions WHERE fund_id=$1 ORDER BY sequence',
    [fund.id],
  );
  assert.deepEqual(rows.map((row) => row.amount).sort(), ['200000', '300000']);
  pass(
    'Demo1: Owner/Holder separated; TEST budget/destination/report/reject/confirm and exact-once 500000 ledger',
  );
  await restartTrip();
  assert.equal((await plan(member)).activities[0].scheduled_date, '2026-11-03');
  assert.equal((await readFund()).current_balance, '500000');
  const leaveKey = randomUUID();
  const leave = await request(
    root + '/leave',
    'POST',
    {
      reason: 'Demo complete',
      expected_membership_revision: (await tripRead()).membership_revision,
    },
    { ...bearer(member), 'idempotency-key': leaveKey },
  );
  assert.ok([200, 202].includes(leave.status));
  await waitFor(async () => {
    const operation = await get('/api/v1/operations/' + leaveKey, member);
    assert.notEqual(operation.state, 'FAILED');
    return operation.state === 'SUCCEEDED';
  }, 45000);
  expected(await request(root, 'GET', undefined, bearer(member)), 404);
  assert.equal((await readFund()).current_balance, '500000');
  pass('Demo1: restart persistence, real Finance-backed Member leave and post-leave denial');
  await stopFinance();
  expected(await request('/health/ready'), 200);
  const diagnostics = await request('/health/dependencies');
  assert.equal(diagnostics.status, 503);
  assert.equal(diagnostics.body.checks.finance, 'down');
  assert.equal(diagnostics.body.checks.trip, 'up');
  expected(await request(root + '/fund', 'GET', undefined, bearer(owner)), 503);
  assert.equal((await plan(owner)).activities[0].scheduled_date, '2026-11-03');
  pass('Demo1: stopped Finance is degraded (not fake empty Fund), while core Plan stays available');
}
