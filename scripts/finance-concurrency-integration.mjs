import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  PaymentRepository,
} = require('../apps/finance-service/dist/repositories/payment.repository.js');

export async function runPaymentCompletionRegressions(
  h,
  { financeDb, attempt, fundId, transactionId, mutate },
) {
  const payment = new PaymentRepository(financeDb);
  const snapshot = async () => ({
    fund: await h.query('finance', 'SELECT * FROM funds WHERE id=$1', [fundId]),
    attempt: await h.query('finance', 'SELECT * FROM payment_attempts WHERE id=$1', [attempt.id]),
    contribution: await h.query('finance', 'SELECT * FROM contributions WHERE id=$1', [
      attempt.contribution_id,
    ]),
    ledger: await h.query(
      'finance',
      'SELECT * FROM fund_transactions WHERE fund_id=$1 ORDER BY id',
      [fundId],
    ),
    audit: await h.query(
      'finance',
      'SELECT * FROM finance_audit_logs WHERE fund_id=$1 ORDER BY id',
      [fundId],
    ),
    events: await h.query(
      'finance',
      'SELECT * FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_id',
      [fundId],
    ),
  });
  const settled = await snapshot();
  assert.equal(settled.attempt[0].status, 'SUCCEEDED');
  assert.equal(settled.attempt[0].provider_transaction_id, transactionId);
  assert.equal(settled.ledger.length, 1);
  const result = (resultCode, extra = {}) => ({
    resultCode,
    orderId: settled.attempt[0].provider_order_id,
    amount: BigInt(settled.attempt[0].amount),
    responseTime: '1800000000000',
    message: 'Synthetic query result',
    ...extra,
  });
  for (const resultCode of [49, 9000]) {
    await payment.completeQuery(attempt.id, result(resultCode));
    assert.deepEqual(
      await snapshot(),
      settled,
      'Late ' + resultCode + ' query must not mutate IPN success, money, versions, audit or events',
    );
  }
  await payment.failQuery(attempt.id);
  assert.deepEqual(
    await snapshot(),
    settled,
    'Late query transport failure must not mutate IPN success',
  );
  h.pass('Late FAILED/PENDING/query failure preserves IPN success and exactly one ledger entry');

  await payment.completeQuery(attempt.id, result(0, { transactionId }));
  assert.deepEqual(
    await snapshot(),
    settled,
    'Same transaction success is an exact financial no-op',
  );
  const replayIpn = async (responseTime) => {
    const row = settled.attempt[0];
    const receipt = await payment.receiveWebhook(
      {
        partnerCode: row.merchant_id,
        orderId: row.provider_order_id,
        requestId: row.client_request_id,
        amount: BigInt(row.amount),
        orderInfo: 'Wolfari contribution ' + attempt.contribution_id,
        orderType: 'momo_wallet',
        transactionId,
        resultCode: 0,
        message: 'Synthetic duplicate successful callback',
        payType: 'qr',
        responseTime,
        extraData: '',
        signature: '0'.repeat(64),
      },
      true,
      row.merchant_id,
    );
    await payment.processWebhook(receipt.id);
    const persisted = (
      await h.query(
        'finance',
        'SELECT processing_status,review_reason FROM payment_webhook_receipts WHERE id=$1',
        [receipt.id],
      )
    )[0];
    assert.equal(persisted.processing_status, 'PROCESSED');
    assert.equal(persisted.review_reason, null);
    return receipt.id;
  };
  const replayId = await replayIpn('1800000000001');
  assert.deepEqual(
    await snapshot(),
    settled,
    'A new IPN receipt for the same transaction must not settle twice',
  );
  const same = await h.query(
    'finance',
    "SELECT id FROM payment_webhook_receipts WHERE payment_attempt_id=$1 AND signature_valid AND processing_status='NEEDS_REVIEW'",
    [attempt.id],
  );
  assert.equal(same.length, 0, 'Same transaction query or IPN must not invent an exception');
  h.pass('Same-transaction query and newly delivered IPN preserve exact financial state');

  const reversal = await mutate(
    '/api/v1/contributions/' + attempt.contribution_id + '/reverse',
    {
      expected_version: settled.contribution[0].version,
      expected_finance_version: settled.fund[0].finance_version,
      reason: 'Payment replay regression',
    },
    h.actors.holder,
  );
  assert.equal(reversal.status, 200, JSON.stringify(reversal.body));
  const reversed = await snapshot();
  assert.equal(reversed.contribution[0].status, 'REVERSED');
  assert.equal(reversed.fund[0].current_balance, '0');
  assert.equal(reversed.ledger.length, 2);
  const reversalLedger = reversed.ledger.find((row) => row.transaction_type === 'REVERSAL');
  assert.equal(reversalLedger.reversal_of_id, settled.ledger[0].id);
  assert.equal(reversalLedger.amount, settled.ledger[0].amount);
  await payment.completeQuery(attempt.id, result(0, { transactionId }));
  const reversedReplayId = await replayIpn('1800000000002');
  assert.notEqual(reversedReplayId, replayId);
  assert.deepEqual(
    await snapshot(),
    reversed,
    'Same provider transaction cannot restore money after an authorized reversal',
  );
  h.pass(
    'Same-transaction query and new IPN after real reversal preserve the linked IN/OUT ledger',
  );

  await payment.completeQuery(
    attempt.id,
    result(49, { amount: BigInt(settled.attempt[0].amount) + 1n }),
  );
  const mismatch = await snapshot();
  for (const field of ['fund', 'contribution', 'ledger', 'audit', 'events'])
    assert.deepEqual(mismatch[field], reversed[field]);
  assert.equal(mismatch.attempt[0].status, 'SUCCEEDED');
  assert.equal(mismatch.attempt[0].needs_reconciliation, true);
  let exceptions = await h.query(
    'finance',
    "SELECT processing_status,review_reason,payload FROM payment_webhook_receipts WHERE payment_attempt_id=$1 AND signature_valid AND processing_status='NEEDS_REVIEW' ORDER BY id",
    [attempt.id],
  );
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].review_reason, 'QUERY_MISMATCH');
  await payment.completeQuery(attempt.id, result(0, { transactionId: '987654321012345678' }));
  const conflict = await snapshot();
  for (const field of ['fund', 'contribution', 'ledger', 'audit', 'events'])
    assert.deepEqual(conflict[field], reversed[field]);
  assert.equal(conflict.attempt[0].status, 'SUCCEEDED');
  assert.equal(conflict.attempt[0].provider_transaction_id, transactionId);
  assert.equal(conflict.attempt[0].needs_reconciliation, true);
  exceptions = await h.query(
    'finance',
    "SELECT processing_status,review_reason,payload FROM payment_webhook_receipts WHERE payment_attempt_id=$1 AND signature_valid AND processing_status='NEEDS_REVIEW' ORDER BY id",
    [attempt.id],
  );
  assert.equal(exceptions.length, 2);
  const different = exceptions.find((row) => row.review_reason === 'QUERY_SUCCESS_CONFLICT');
  assert(different);
  assert.equal(different.payload.transaction_id, '987654321012345678');
  h.pass(
    'Mismatched query and different provider transaction create review exceptions without changing settled or reversed money',
  );
  // Wrong order, but correct merchant and amount, reaches LINKED's terminal-state guard.
  const linkedOrder = 'unmatched-' + randomUUID();
  await payment.completeQuery(
    attempt.id,
    result(49, { orderId: linkedOrder, responseTime: '1800000000003' }),
  );
  const linkedReceipt = (
    await h.query(
      'finance',
      "SELECT * FROM payment_webhook_receipts WHERE payment_attempt_id=$1 AND payload->>'order_id'=$2",
      [attempt.id, linkedOrder],
    )
  )[0];
  assert.equal(linkedReceipt.review_reason, 'QUERY_MISMATCH');
  const beforeLinked = await snapshot();
  const resolveLinked = (linkedAttemptId, database = financeDb) =>
    database.withTransaction((client) =>
      new PaymentRepository(database).execute(
        client,
        {
          scope: 'RESOLVE_PAYMENT_EXCEPTION',
          actor: h.actors.holder.id,
          tripId: beforeLinked.fund[0].trip_id,
          fundId,
          paymentExceptionId: linkedReceipt.id,
          operationId: randomUUID(),
          hash: 'c'.repeat(64),
          body: {
            resolution: 'LINKED',
            linkedAttemptId,
            reason: 'Synthetic resolution regression',
            expectedFinanceVersion: beforeLinked.fund[0].finance_version,
          },
        },
        {
          actorUserId: h.actors.holder.id,
          ownerUserId: h.actors.owner.id,
          activeMemberUserIds: new Set([h.actors.owner.id, h.actors.holder.id, h.actors.member.id]),
          tripArchived: false,
        },
        randomUUID(),
      ),
    );
  await assert.rejects(resolveLinked(attempt.id), { code: 'STATE_CONFLICT' });
  assert.deepEqual(
    await snapshot(),
    beforeLinked,
    'LINKED failure must not downgrade an already settled attempt',
  );
  assert.deepEqual(
    (
      await h.query('finance', 'SELECT * FROM payment_webhook_receipts WHERE id=$1', [
        linkedReceipt.id,
      ])
    )[0],
    linkedReceipt,
    'Rejected LINKED must not change or mark the receipt reviewed',
  );
  h.pass(
    'LINKED failed callback rejects settled SUCCEEDED without attempt, receipt, money, audit or event writes',
  );

  // A synthetic peer Fund has no service-crossing foreign key; its held root must never be locked.
  const peerFund = randomUUID(),
    peerAttempt = randomUUID(),
    peerRequest = randomUUID(),
    peerContribution = randomUUID();
  await h.transaction('finance', async (client) => {
    await client.query('INSERT INTO funds(id,trip_id,holder_user_id) VALUES($1,$2,$3)', [
      peerFund,
      randomUUID(),
      h.actors.holder.id,
    ]);
    await client.query(
      "INSERT INTO contribution_requests(id,fund_id,title,status,created_by_user_id,closed_at) VALUES($1,$2,'Peer Fund fixture','CLOSED',$3,now())",
      [peerRequest, peerFund, h.actors.owner.id],
    );
    await client.query(
      "INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,waived_reason,waived_at) VALUES($1,$2,$3,$4,50000,'WAIVED','{}',1,'Peer fixture',now())",
      [peerContribution, peerRequest, peerFund, h.actors.member.id],
    );
    await client.query(
      "INSERT INTO payment_attempts(id,contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot) VALUES($1,$2,'MOMO_SANDBOX','SANDBOX',50000,$3,'FAILED','MOMO_TEST',$4,'{}')",
      [peerAttempt, peerContribution, randomUUID(), 'WLF-' + peerAttempt],
    );
  });
  const peerHeld = signal(),
    releasePeer = signal();
  const peerOutcome = captureOutcome(
    h.transaction('finance', async (client) => {
      await client.query('SELECT id FROM funds WHERE id=$1 FOR UPDATE', [peerFund]);
      peerHeld.resolve();
      await releasePeer.promise;
    }),
  );
  try {
    await bounded(peerHeld.promise, 'peer Fund held');
    const outcome = await bounded(
      captureOutcome(resolveLinked(peerAttempt, observedDatabase(h))),
      'wrong-Fund rejection while peer is still locked',
      2000,
    );
    assert.equal(outcome.error?.code, 'RESOURCE_NOT_FOUND');
    assert.deepEqual(await snapshot(), beforeLinked);
    assert.deepEqual(
      (
        await h.query('finance', 'SELECT * FROM payment_webhook_receipts WHERE id=$1', [
          linkedReceipt.id,
        ])
      )[0],
      linkedReceipt,
    );
  } finally {
    releasePeer.resolve();
    valueOf(await bounded(peerOutcome, 'peer Fund release'));
  }
  const ignored = await mutate(
    '/api/v1/payment-exceptions/' + linkedReceipt.id + '/resolve',
    {
      resolution: 'NO_FINANCIAL_EFFECT',
      reason: 'Verified failed provider response has no financial effect',
      expected_finance_version: beforeLinked.fund[0].finance_version,
    },
    h.actors.holder,
  );
  assert.equal(ignored.status, 200, JSON.stringify(ignored.body));
  assert.equal(ignored.body.data.processing_status, 'IGNORED');
  const afterIgnored = await snapshot();
  assert.deepEqual(afterIgnored.attempt, beforeLinked.attempt);
  assert.deepEqual(afterIgnored.contribution, beforeLinked.contribution);
  assert.deepEqual(afterIgnored.ledger, beforeLinked.ledger);
  assert.deepEqual(afterIgnored.events, beforeLinked.events);
  assert.equal(afterIgnored.fund[0].current_balance, beforeLinked.fund[0].current_balance);
  assert.equal(afterIgnored.fund[0].finance_version, beforeLinked.fund[0].finance_version + 1);
  h.pass(
    'Wrong-Fund LINKED rejects while the peer Fund is held; NO_FINANCIAL_EFFECT still resolves without changing money',
  );
}

const {
  ClosureRepository,
} = require('../apps/finance-service/dist/repositories/closure.repository.js');

function closureHarness(h, helpers) {
  const { financeDb, createFund, createClosure, action } = helpers;
  const { owner, holder, outsider } = h.actors;
  const users = [owner, holder, outsider];
  const payment = new PaymentRepository(financeDb);
  const create = async (withClosure = true) => {
    const fixture = await createFund();
    fixture.requestId = randomUUID();
    fixture.contributionId = randomUUID();
    fixture.attemptId = randomUUID();
    fixture.clientRequestId = randomUUID();
    fixture.orderId = 'WLF-' + fixture.attemptId;
    await h.transaction('finance', async (client) => {
      await client.query(
        "INSERT INTO contribution_requests(id,fund_id,title,status,created_by_user_id,closed_at) VALUES($1,$2,'Terminal concurrency fixture','CLOSED',$3,now())",
        [fixture.requestId, fixture.fundId, owner.id],
      );
      await client.query(
        "INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,waived_reason,waived_at) VALUES($1,$2,$3,$4,1000,'WAIVED','{}',1,'Synthetic terminal fixture',now())",
        [fixture.contributionId, fixture.requestId, fixture.fundId, outsider.id],
      );
      await client.query(
        "INSERT INTO payment_attempts(id,contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot) VALUES($1,$2,'MOMO_SANDBOX','SANDBOX',1000,$3,'FAILED','MOMO_TEST',$4,'{}')",
        [fixture.attemptId, fixture.contributionId, fixture.clientRequestId, fixture.orderId],
      );
    });
    if (withClosure) fixture.closure = await createClosure(fixture);
    return fixture;
  };
  const snapshot = async (f) => ({
    fund: await h.query('finance', 'SELECT * FROM funds WHERE id=$1', [f.fundId]),
    closure: await h.query('finance', 'SELECT * FROM finance_closures WHERE id=$1', [f.closure.id]),
    confirmations: await h.query(
      'finance',
      'SELECT * FROM closure_confirmations WHERE closure_id=$1 ORDER BY user_id',
      [f.closure.id],
    ),
    ledger: await h.query(
      'finance',
      'SELECT * FROM fund_transactions WHERE fund_id=$1 ORDER BY id',
      [f.fundId],
    ),
    audit: await h.query(
      'finance',
      'SELECT * FROM finance_audit_logs WHERE fund_id=$1 ORDER BY id',
      [f.fundId],
    ),
    events: await h.query(
      'finance',
      'SELECT * FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_id',
      [f.fundId],
    ),
  });
  const confirm = (f, user, database = financeDb) =>
    database.withTransaction((client) =>
      new ClosureRepository(database).execute(
        client,
        {
          scope: 'CONFIRM_CLOSURE',
          actor: user.id,
          tripId: f.tripId,
          fundId: f.fundId,
          closureId: f.closure.id,
          operationId: randomUUID(),
          hash: 'a'.repeat(64),
          body: { snapshotHash: f.closure.snapshot_hash },
        },
        {
          actorUserId: user.id,
          ownerUserId: owner.id,
          activeMemberUserIds: new Set(users.map((item) => item.id)),
          tripArchived: false,
          closureLockId: f.closure.id,
        },
        randomUUID(),
      ),
    );
  const webhook = (f, overrides = {}) => ({
    partnerCode: 'MOMO_TEST',
    orderId: f.orderId,
    requestId: f.clientRequestId,
    amount: 1001n,
    orderInfo: 'Wolfari contribution ' + f.contributionId,
    orderType: 'momo_wallet',
    transactionId: '12300000001',
    resultCode: 49,
    message: 'Synthetic failed callback',
    payType: 'qr',
    responseTime: '1800000000000',
    extraData: '',
    signature: '0'.repeat(64),
    ...overrides,
  });
  const queryResult = (f) => ({
    orderId: f.orderId,
    amount: 1001n,
    resultCode: 49,
    responseTime: '1800000000000',
    message: 'Synthetic mismatched query',
  });
  const cancel = async (f) => {
    await action(f.closure, 'cancel', { reason: 'Cancel after late exception' }, owner);
    const state = await snapshot(f);
    assert.equal(state.fund[0].status, 'OPEN');
    assert.equal(state.closure[0].status, 'CANCELLED');
    assert.equal(
      (await h.query('trip', 'SELECT closure_lock_id FROM trips WHERE id=$1', [f.tripId]))[0]
        .closure_lock_id,
      null,
    );
  };
  return { create, snapshot, confirm, webhook, queryResult, cancel, payment, users, financeDb };
}

export async function runClosureConcurrencyTests(h, helpers) {
  const c = closureHarness(h, helpers);
  for (const source of ['webhook', 'query']) {
    for (const confirmedCount of [0, 1, 2]) {
      const fixture = await c.create();
      for (const user of c.users.slice(0, confirmedCount)) await c.confirm(fixture, user);
      if (source === 'webhook') {
        const receipt = await c.payment.receiveWebhook(c.webhook(fixture), true, 'MOMO_TEST');
        assert.equal(receipt.processing_status, 'NEEDS_REVIEW');
        assert.equal(receipt.review_reason, 'AMOUNT_MISMATCH');
      } else await c.payment.completeQuery(fixture.attemptId, c.queryResult(fixture));
      const before = await c.snapshot(fixture);
      await assert.rejects(
        c.confirm(fixture, c.users[confirmedCount]),
        { code: 'STATE_CONFLICT' },
        source + ' exception must block confirmation ' + (confirmedCount + 1),
      );
      assert.deepEqual(
        await c.snapshot(fixture),
        before,
        'Rejected confirmation must not write any state, audit or event',
      );
      if (confirmedCount > 0) {
        await c.confirm(fixture, c.users[0]);
        assert.deepEqual(
          await c.snapshot(fixture),
          before,
          'An existing confirmation stays a no-op despite later blockers',
        );
      }
      await c.cancel(fixture);
    }
    h.pass(
      'Late valid ' +
        source +
        ' exceptions block first/intermediate/final closure confirmations without writes; no-op and cancellation remain valid',
    );
  }
  const invalid = await c.create();
  const receipt = await c.payment.receiveWebhook(c.webhook(invalid), false, 'MOMO_TEST');
  assert.equal(receipt.processing_status, 'IGNORED');
  assert.equal(receipt.review_reason, 'INVALID_SIGNATURE');
  for (const user of c.users) await c.confirm(invalid, user);
  const closed = await c.snapshot(invalid);
  assert.equal(closed.fund[0].status, 'CLOSED');
  assert.equal(closed.closure[0].status, 'COMPLETED');
  assert.equal(closed.events.filter((event) => event.event_type === 'FinanceClosed').length, 1);
  h.pass('Invalid signatures remain nonblocking for closure completion');
  await runClosureLockRegressions(h, c);
}

const {
  LifecycleFinanceRepository,
} = require('../apps/finance-service/dist/repositories/lifecycle-finance.repository.js');

const signal = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise, label, timeout = 6000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const captureOutcome = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
const valueOf = (outcome) => {
  if (outcome.error) throw outcome.error;
  return outcome.value;
};
const isFundLock = (sql) => /\bFROM funds\b/i.test(sql) && /\bFOR UPDATE\b/i.test(sql);

// Barriers live in the test's database adapter, never in production repository code.
function observedDatabase(h, { started, before, after } = {}) {
  const withTransaction = (work) =>
    h.transaction('finance', async (client) => {
      await client.query("SET LOCAL statement_timeout='6s'");
      await client.query("SET LOCAL lock_timeout='4s'");
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      started?.resolve(pid);
      return work({
        query: async (sql, args) => {
          const context = { sql, args, pid, client };
          await before?.(context);
          const result = await client.query(sql, args);
          await after?.({ ...context, result });
          return result;
        },
      });
    });
  return {
    withTransaction,
    query: (sql, args) => withTransaction((client) => client.query(sql, args)),
  };
}
function queryBarrier(predicate) {
  const entered = signal(),
    released = signal();
  let reached = false;
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    after: async (context) => {
      if (reached || !predicate(context.sql)) return;
      reached = true;
      entered.resolve(context.pid);
      await released.promise;
    },
  };
}
async function assertBlockedBy(h, waiting, holding, label) {
  const until = Date.now() + 2500;
  do {
    const rows = await h.query('finance', 'SELECT pg_blocking_pids($1::int) AS blockers', [
      waiting,
    ]);
    if (rows[0].blockers.includes(holding)) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  assert.fail(label + ': backend ' + waiting + ' was not blocked by backend ' + holding);
}

async function runClosureLockRegressions(h, c) {
  // A durable exception must be visible before a waiting confirmation can proceed.
  const ingressFirst = await c.create();
  const ingressBarrier = queryBarrier((sql) => /INSERT INTO payment_webhook_receipts/i.test(sql));
  const ingressDb = observedDatabase(h, { after: ingressBarrier.after });
  let ingressOutcome, confirmationOutcome;
  const confirmationStarted = signal();
  const before = await c.snapshot(ingressFirst);
  try {
    ingressOutcome = captureOutcome(
      new PaymentRepository(ingressDb).receiveWebhook(c.webhook(ingressFirst), true, 'MOMO_TEST'),
    );
    const ingressPid = await bounded(
      ingressBarrier.entered,
      'receipt inserted inside ingress transaction',
    );
    const confirmDb = observedDatabase(h, { started: confirmationStarted });
    confirmationOutcome = captureOutcome(c.confirm(ingressFirst, c.users[0], confirmDb));
    const confirmationPid = await bounded(
      confirmationStarted.promise,
      'confirmation transaction started',
    );
    assert.notEqual(confirmationPid, ingressPid);
    await assertBlockedBy(
      h,
      confirmationPid,
      ingressPid,
      'Confirmation waits for valid ingress Fund lock',
    );
    assert.deepEqual(await c.snapshot(ingressFirst), before);
  } finally {
    ingressBarrier.release();
    if (ingressOutcome) valueOf(await bounded(ingressOutcome, 'ingress commit'));
    if (confirmationOutcome) {
      const outcome = await bounded(confirmationOutcome, 'confirmation rejection');
      assert.equal(outcome.error?.code, 'STATE_CONFLICT');
    }
  }
  assert.deepEqual(await c.snapshot(ingressFirst), before);
  await c.cancel(ingressFirst);
  h.pass(
    'Two PostgreSQL sessions prove valid ingress holds Fund until commit and blocks a new confirmation without writes',
  );

  // Conversely, ingress must not insert a receipt halfway through a confirmation.
  for (const priorConfirmations of [0, 2]) {
    const confirmFirst = await c.create();
    for (const user of c.users.slice(0, priorConfirmations)) await c.confirm(confirmFirst, user);
    const beforeConfirm = await c.snapshot(confirmFirst);
    const confirmBarrier = queryBarrier(isFundLock);
    const confirmDb = observedDatabase(h, { after: confirmBarrier.after });
    const ingressStarted = signal();
    let firstOutcome, lateOutcome;
    try {
      firstOutcome = captureOutcome(
        c.confirm(confirmFirst, c.users[priorConfirmations], confirmDb),
      );
      const confirmPid = await bounded(confirmBarrier.entered, 'confirmation Fund lock');
      lateOutcome = captureOutcome(
        new PaymentRepository(observedDatabase(h, { started: ingressStarted })).receiveWebhook(
          c.webhook(confirmFirst),
          true,
          'MOMO_TEST',
        ),
      );
      const ingressPid = await bounded(ingressStarted.promise, 'late ingress transaction');
      assert.notEqual(confirmPid, ingressPid);
      await assertBlockedBy(h, ingressPid, confirmPid, 'Ingress waits for confirmation Fund lock');
      assert.equal(
        (
          await h.query(
            'finance',
            'SELECT id FROM payment_webhook_receipts WHERE payment_attempt_id=$1',
            [confirmFirst.attemptId],
          )
        ).length,
        0,
        'Blocked ingress must not insert a receipt yet',
      );
    } finally {
      confirmBarrier.release();
      if (firstOutcome) valueOf(await bounded(firstOutcome, 'first confirmation commit'));
      if (lateOutcome) valueOf(await bounded(lateOutcome, 'late ingress commit'));
    }
    const afterFirst = await c.snapshot(confirmFirst);
    assert.equal(
      afterFirst.confirmations.filter((row) => row.confirmed_at !== null).length,
      priorConfirmations + 1,
    );
    if (priorConfirmations === 0) {
      await assert.rejects(c.confirm(confirmFirst, c.users[1]), { code: 'STATE_CONFLICT' });
      assert.deepEqual(await c.snapshot(confirmFirst), afterFirst);
      await c.cancel(confirmFirst);
      h.pass(
        'Reverse transaction order serializes receipt insertion after confirmation and blocks the next confirmation',
      );
    } else {
      assert.equal(afterFirst.fund[0].status, 'CLOSED');
      assert.equal(afterFirst.closure[0].status, 'COMPLETED');
      assert.equal(afterFirst.fund[0].finance_version, beforeConfirm.fund[0].finance_version + 1);
      assert.deepEqual(afterFirst.ledger, beforeConfirm.ledger);
      assert.equal(
        afterFirst.events.filter((event) => event.event_type === 'FinanceClosed').length,
        1,
      );
      const receipt = await h.query(
        'finance',
        'SELECT processing_status,review_reason FROM payment_webhook_receipts WHERE payment_attempt_id=$1',
        [confirmFirst.attemptId],
      );
      assert.equal(receipt.length, 1);
      assert.equal(receipt[0].processing_status, 'NEEDS_REVIEW');
      assert.equal(receipt[0].review_reason, 'AMOUNT_MISMATCH');
      assert.equal(
        (
          await h.query(
            'finance',
            'SELECT status,needs_reconciliation FROM payment_attempts WHERE id=$1',
            [confirmFirst.attemptId],
          )
        )[0].needs_reconciliation,
        true,
      );
      h.pass(
        'Final confirmation can commit first; waiting valid ingress records review without reopening Fund or changing ledger',
      );
    }
  }

  // Both query mismatch and transport failure introduce blockers under the same Fund lock.
  for (const operation of ['completeQuery', 'failQuery']) {
    const fixture = await c.create();
    const barrier = queryBarrier(isFundLock);
    const queryStarted = signal();
    let confirmation, query;
    try {
      confirmation = captureOutcome(
        c.confirm(fixture, c.users[0], observedDatabase(h, { after: barrier.after })),
      );
      const confirmPid = await bounded(barrier.entered, 'confirmation before ' + operation);
      const payment = new PaymentRepository(observedDatabase(h, { started: queryStarted }));
      query = captureOutcome(
        operation === 'completeQuery'
          ? payment.completeQuery(fixture.attemptId, c.queryResult(fixture))
          : payment.failQuery(fixture.attemptId),
      );
      const queryPid = await bounded(queryStarted.promise, operation + ' transaction');
      await assertBlockedBy(h, queryPid, confirmPid, operation + ' waits for Fund');
    } finally {
      barrier.release();
      if (confirmation) valueOf(await bounded(confirmation, operation + ' prior confirmation'));
      if (query) valueOf(await bounded(query, operation + ' commit'));
    }
    const beforeBlocked = await c.snapshot(fixture);
    await assert.rejects(c.confirm(fixture, c.users[1]), { code: 'STATE_CONFLICT' });
    assert.deepEqual(await c.snapshot(fixture), beforeBlocked);
    await c.cancel(fixture);
  }
  h.pass('Query mismatch and query failure wait on Fund and block subsequent closure confirmation');

  // Lifecycle owns Fund first. The webhook worker must wait without first owning its receipt.
  const fixture = await c.create(false);
  const lifecycleBarrier = queryBarrier(isFundLock);
  const lifecycle = new LifecycleFinanceRepository(
    observedDatabase(h, { after: lifecycleBarrier.after }),
  );
  const membership = (
    await h.query('trip', 'SELECT id FROM trip_members WHERE trip_id=$1 AND user_id=$2', [
      fixture.tripId,
      c.users[2].id,
    ])
  )[0];
  const workerStarted = signal();
  let lifecycleOutcome, workerOutcome;
  const receiptId = randomUUID();
  try {
    lifecycleOutcome = captureOutcome(
      lifecycle.execute(
        {
          operation_id: randomUUID(),
          request_hash: 'b'.repeat(64),
          operation_type: 'LEAVE_MEMBER',
          authorization_context: {
            actor: { actor_user_id: c.users[2].id },
            trip_id: fixture.tripId,
            context_revision: 1,
            active_user_ids: c.users.map((user) => user.id),
            command_scope: 'LEAVE_MEMBER',
          },
          membership_target: {
            membership_id: membership.id,
            user_id: c.users[2].id,
            reason: 'Synthetic concurrent lifecycle check',
          },
        },
        randomUUID(),
      ),
    );
    const lifecyclePid = await bounded(lifecycleBarrier.entered, 'lifecycle Fund lock');
    // Seed a visible received receipt while Fund is held; background workers also have to wait.
    await h.query(
      'finance',
      "INSERT INTO payment_webhook_receipts(id,provider,environment,dedupe_key,payment_attempt_id,signature_valid,received_amount,payload,processing_status) VALUES($1,'MOMO_SANDBOX','SANDBOX',$2,$3,true,1000,$4::jsonb,'RECEIVED')",
      [
        receiptId,
        randomUUID(),
        fixture.attemptId,
        JSON.stringify({ result_code: 49, transaction_id: '12300000002' }),
      ],
    );
    workerOutcome = captureOutcome(
      new PaymentRepository(observedDatabase(h, { started: workerStarted })).processWebhook(
        receiptId,
      ),
    );
    const workerPid = await bounded(workerStarted.promise, 'webhook worker transaction');
    await assertBlockedBy(h, workerPid, lifecyclePid, 'Webhook worker waits for lifecycle Fund');
    await h.transaction('finance', (client) =>
      client.query('SELECT id FROM payment_webhook_receipts WHERE id=$1 FOR UPDATE NOWAIT', [
        receiptId,
      ]),
    );
  } finally {
    lifecycleBarrier.release();
    if (lifecycleOutcome) {
      const result = valueOf(await bounded(lifecycleOutcome, 'lifecycle terminal result'));
      assert.equal(result.outcome.error_code, 'FINANCE_OBLIGATION_BLOCKED');
    }
    if (workerOutcome) valueOf(await bounded(workerOutcome, 'webhook processing after lifecycle'));
  }
  assert.equal(
    (
      await h.query(
        'finance',
        'SELECT processing_status FROM payment_webhook_receipts WHERE id=$1',
        [receiptId],
      )
    )[0].processing_status,
    'PROCESSED',
  );
  assert.equal(
    (
      await h.query('finance', 'SELECT status FROM payment_attempts WHERE id=$1', [
        fixture.attemptId,
      ])
    )[0].status,
    'FAILED',
  );
  assert.equal(
    (
      await h.query('finance', 'SELECT id FROM fund_transactions WHERE fund_id=$1', [
        fixture.fundId,
      ])
    ).length,
    0,
  );
  h.pass(
    'Lifecycle and webhook processing use Fund before receipt: observed SQL blocking, receipt NOWAIT and both terminal results avoid lock inversion',
  );
}
