import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, waitFor } from './demo-scenarios.mjs';
import { connectDatabase } from './migrations.mjs';

async function read(path, actor) {
  return (await api(path, 'GET', undefined, actor)).data;
}

// A pending acknowledgement is not a receipt. Reuse the original intent after recovery.
async function financeWrite(path, body, actor, key = randomUUID(), expected = [200]) {
  const send = (statuses) => api(path, 'POST', body, actor, key, statuses);
  const result = await send([...expected, 202]);
  if (result.status !== 202) return result;
  await waitFor(async () => {
    const { state } = await read('/api/v1/operations/' + key, actor);
    if (state === 'NEEDS_REVIEW') throw new Error('DEMO_OPERATION_NEEDS_REVIEW');
    return state === 'SUCCEEDED' || state === 'FAILED';
  });
  return send(expected);
}

export async function demonstrateFund({ actors, fundBase, getFund, destinationId, pass }) {
  const { owner, holder, member } = actors;
  const list = async () => (await read(fundBase + '/contributions?limit=100', owner)).items;
  const ledger = async () => (await read(fundBase + '/transactions?limit=100', owner)).items;
  const balance = async () => (await getFund()).current_balance;
  assert.equal(await balance(), '0');
  assert.equal((await ledger()).length, 0);
  const request = await financeWrite(
    fundBase + '/contribution-requests',
    {
      title: 'Demo kiểm thử quỹ – hai khoản đóng',
      contributions: [
        { member_user_id: member.id, amount: '200000', destination_id: destinationId },
        { member_user_id: owner.id, amount: '300000', destination_id: destinationId },
      ],
      expected_finance_version: (await getFund()).finance_version,
    },
    owner,
    randomUUID(),
    [201],
  );
  const rows = await list();
  assert.equal(request.data.contributions.length, 2);
  assert.equal(rows.length, 2);
  const first = rows.find((row) => row.member_user_id === member.id);
  const second = rows.find((row) => row.member_user_id === owner.id);
  assert.deepEqual(
    [first.status, first.amount, second.status, second.amount],
    ['PENDING', '200000', 'PENDING', '300000'],
  );
  pass('API01 – Tạo hai nghĩa vụ PENDING', { amounts: [first.amount, second.amount] });

  const contribution = async (id) => (await list()).find((row) => row.id === id);
  const versions = async (id) => ({
    expected_version: (await contribution(id)).version,
    expected_finance_version: (await getFund()).finance_version,
  });
  const path = (id, action) => '/api/v1/contributions/' + id + '/' + action;
  const report = async (id, actor) =>
    financeWrite(path(id, 'report-transfer'), await versions(id), actor);
  await report(first.id, member);
  assert.equal((await contribution(first.id)).status, 'TRANSFER_REPORTED');
  assert.equal(await balance(), '0');
  assert.equal((await ledger()).length, 0);
  pass('API02 – Báo chuyển chưa làm tăng số dư', { balance: '0', entries: 0 });

  const confirmFirst = path(first.id, 'confirm-received');
  await financeWrite(confirmFirst, await versions(first.id), owner, randomUUID(), [403]);
  assert.equal((await contribution(first.id)).status, 'TRANSFER_REPORTED');
  assert.equal(await balance(), '0');
  assert.equal((await ledger()).length, 0);
  pass('API06 – Owner khác Holder bị từ chối xác nhận', { http: 403 });

  const reason = 'TEST – chưa nhận đủ tiền';
  await financeWrite(
    path(first.id, 'reject-transfer'),
    { ...(await versions(first.id)), reason },
    holder,
  );
  const rejected = await contribution(first.id);
  assert.deepEqual(
    [rejected.status, rejected.rejected_reason, await balance(), (await ledger()).length],
    ['PENDING', reason, '0', 0],
  );
  pass('API03 – Holder từ chối, giữ lý do và số dư', { status: rejected.status, reason });

  await report(first.id, member);
  const body = await versions(first.id);
  const key = randomUUID();
  const receipt = await financeWrite(confirmFirst, body, holder, key);
  assert.equal((await contribution(first.id)).status, 'CONFIRMED');
  assert.equal(await balance(), '200000');
  const entry = await ledger();
  assert.equal(entry.length, 1);
  assert.deepEqual(
    [entry[0].contribution_id, entry[0].direction, entry[0].amount],
    [first.id, 'IN', '200000'],
  );
  pass('API04 – Xác nhận đúng một dòng thu 200.000 VND', { balance: '200000', entries: 1 });
  const replay = await financeWrite(confirmFirst, body, holder, key);
  assert.deepEqual(replay.data, receipt.data);
  assert.equal(await balance(), '200000');
  assert.deepEqual(
    (await ledger()).map((row) => row.id),
    [entry[0].id],
  );
  pass('API05 – Phát lại cùng khóa giữ nguyên biên nhận và số dư');

  await report(second.id, owner);
  const current = await versions(second.id);
  const results = await Promise.all(
    [randomUUID(), randomUUID()].map((intent) =>
      financeWrite(path(second.id, 'confirm-received'), current, holder, intent, [200, 409]),
    ),
  );
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal((await contribution(second.id)).status, 'CONFIRMED');
  const final = await getFund();
  const entries = await ledger();
  assert.deepEqual([final.status, final.current_balance], ['OPEN', '500000']);
  assert.deepEqual(
    entries.map((row) => [row.contribution_id, row.direction, row.amount, row.balance_after]),
    [
      [second.id, 'IN', '300000', '500000'],
      [first.id, 'IN', '200000', '200000'],
    ],
  );
  pass('API07 – Hai xác nhận đồng thời, tổng quỹ 500.000 VND và đúng hai dòng IN', {
    http: statuses,
    balance: final.current_balance,
    ledger: entries.map((row) => ({
      direction: row.direction,
      amount: row.amount,
      balanceAfter: row.balance_after,
    })),
  });
}

export async function demonstratePriceWatch({ actors, base, demo, pass }) {
  const { owner, member, outsider } = actors;
  const watches = base + '/price-watches';
  const depart = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const query = {
    provider: 'MOCK_FLIGHT',
    origin: 'DAD',
    destination: 'HAN',
    departure_date: depart.slice(0, 10),
    departure_at: depart,
    journey_type: 'ONE_WAY',
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin_class: 'ECONOMY',
    currency: 'VND',
  };
  const create = async (actor, threshold) =>
    (
      await api(
        watches,
        'POST',
        { ...query, threshold_price: threshold },
        actor,
        randomUUID(),
        [201],
      )
    ).data;
  // Register the eligible watch first, even if the worker runs between the two requests.
  const high = await create(member, '9000000');
  const low = await create(owner, '1');
  assert.notEqual(high.id, low.id);
  assert.equal(high.user_id, member.id);
  assert.equal(low.user_id, owner.id);
  assert.deepEqual([high.threshold_price, low.threshold_price], ['9000000', '1']);
  assert.equal(high.query_group_id, low.query_group_id);
  pass('API08 – Hai người, hai ngưỡng, cùng một nhóm truy vấn', {
    queryGroupId: high.query_group_id,
    highWatchId: high.id,
    lowWatchId: low.id,
    thresholds: [high.threshold_price, low.threshold_price],
  });

  const watchPath = (id) => '/api/v1/price-watches/' + id;
  const observations = (id, actor) => read(watchPath(id) + '/observations', actor);
  const alerted = await waitFor(async () =>
    (await read(watches, member)).find((row) => row.id === high.id && row.last_alert_at),
  );
  const common = (await observations(high.id, member)).find(
    (row) => row.price === alerted.last_alert_price,
  );
  assert.ok(common);
  assert.equal(common.provider, 'MOCK_FLIGHT');
  assert.equal(common.currency, 'VND');
  assert.ok(
    BigInt(common.price) < BigInt(high.threshold_price) &&
      BigInt(common.price) >= BigInt(low.threshold_price),
  );
  assert.ok(
    (await observations(low.id, owner)).some(
      (row) => row.id === common.id && row.price === common.price,
    ),
  );
  const lowState = (await read(watches, owner)).find((row) => row.id === low.id);
  assert.equal(lowState.last_alert_at, null);
  const db = await connectDatabase('automation', demo.configs['automation-service'].DATABASE_URL);
  try {
    const {
      rows: [slot],
    } = await db.query(
      `SELECT a.scheduled_slot,
        (SELECT count(*)::int FROM price_query_attempts b WHERE b.query_group_id = a.query_group_id AND b.scheduled_slot = a.scheduled_slot) AS attempts,
        (SELECT count(*)::int FROM price_observations p WHERE p.query_attempt_id = a.id) AS observations
      FROM price_observations o JOIN price_query_attempts a ON a.id = o.query_attempt_id
      WHERE o.id = $1 AND a.query_group_id = $2 AND a.status = 'SUCCEEDED'`,
      [common.id, high.query_group_id],
    );
    assert.ok(slot);
    assert.deepEqual([slot.attempts, slot.observations], [1, 1]);
    const alerts = await db.query(
      `SELECT user_id, source_id, status FROM notifications
       WHERE type = 'PRICE_ALERT' AND source_id IN ($1, $2)`,
      [high.id, low.id],
    );
    assert.deepEqual(alerts.rows, [
      { user_id: member.id, source_id: high.id, status: 'AVAILABLE' },
    ]);
    pass('API09 – Một attempt trong slot, cùng giá quan sát, chỉ ngưỡng cao có cảnh báo', {
      slotUtc: slot.scheduled_slot,
      attempts: slot.attempts,
      observations: slot.observations,
      provider: common.provider,
      observationId: common.id,
      priceVnd: common.price,
      highLastAlertAt: alerted.last_alert_at,
      lowLastAlertAt: lowState.last_alert_at,
      inAppAlerts: alerts.rowCount,
    });
  } finally {
    await db.end();
  }
  await api(watches, 'GET', undefined, outsider, undefined, [404]);
  pass('API11 – Người ngoài Trip không đọc được watch', { http: 404 });
  const route = watchPath(low.id);
  const action = (name, version, expected = [200]) =>
    api(route + '/' + name, 'POST', { expected_version: version }, owner, undefined, expected);
  const paused = (await action('pause', lowState.version)).data;
  assert.equal(paused.status, 'PAUSED');
  await api(
    route,
    'PATCH',
    { expected_version: lowState.version, threshold_price: '2' },
    owner,
    undefined,
    [409],
  );
  const afterConflict = (await read(watches, owner)).find((row) => row.id === low.id);
  assert.deepEqual([afterConflict.version, afterConflict.threshold_price], [paused.version, '1']);
  pass('API12 – Phiên bản cũ nhận 409 và không đổi ngưỡng', {
    http: 409,
    threshold: afterConflict.threshold_price,
  });
  const resumed = (await action('resume', paused.version)).data;
  assert.equal(resumed.status, 'ACTIVE');
  const stopped = (await action('stop', resumed.version)).data;
  assert.equal(stopped.status, 'STOPPED');
  await action('resume', stopped.version, [409]);
  pass('API10 – Pause, resume, stop và từ chối resume sau stop', {
    states: [paused.status, resumed.status, stopped.status],
  });
}
