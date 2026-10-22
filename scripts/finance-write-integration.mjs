import { runPaymentInstructionTests } from './finance-payment-instruction-integration.mjs';
import { runManualContributionTests } from './finance-manual-contribution-integration.mjs';
import { runFinanceReceiptTests } from './finance-receipt-integration.mjs';
import { runContributionManagementTests } from './finance-contribution-management-integration.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runFinanceConfigurationTests } from './finance-configuration-integration.mjs';
import { runContributionRequestTests } from './finance-contribution-request-integration.mjs';
import { runContributionReversalTests } from './finance-contribution-reversal-integration.mjs';
const require = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('../apps/api-gateway/package.json', import.meta.url));
const { Client, credentials, Metadata } = apiRequire('@grpc/grpc-js');
const { loadSync } = apiRequire('@grpc/proto-loader');
const { PROTO_PATHS, GRPC_LOADER_OPTIONS } = apiRequire('@wolfari/contracts/grpc');
const {
  FundTripClient,
  FundCommandService,
} = require('../apps/finance-service/dist/application/fund-command.service.js');
const {
  FundCommandRepository,
  fundCommandHash,
} = require('../apps/finance-service/dist/repositories/fund-command.repository.js');
const { FundRepository } = require('../apps/finance-service/dist/repositories/fund.repository.js');
const {
  FinanceOperationService,
} = require('../apps/trip-workspace-service/dist/operations/finance-operation.service.js');
const {
  MembershipRepository,
} = require('../apps/trip-workspace-service/dist/membership/membership.repository.js');
const { parseEnableFundInput } = require('../apps/finance-service/dist/inputs/fund-setup.input.js');

export async function runFinanceWriteTests(h) {
  const { request, query, transaction, bearer, tripBody, pass, waitFor } = h;
  const { owner, holder, outsider } = h.actors;
  const config = {
    get: (key) =>
      ({ TRIP_GRPC_TARGET: h.tripTarget, FINANCE_TRIP_SECRET: h.tripSecret, NODE_ENV: 'test' })[
        key
      ],
  };
  const tripClient = new FundTripClient(config);
  const db = (service) => ({
    query: (sql, args) => transaction(service, (c) => c.query(sql, args)),
    withTransaction: (work) => transaction(service, work),
  });
  const financeDb = db('finance'),
    tripDb = db('trip');
  const repo = new FundCommandRepository(financeDb);
  const rpcClient = new Client(h.financeTarget, credentials.createInsecure());
  const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
    'wolfari.finance.v1.FinanceService'
  ];
  const rpc = (name, input, caller = 'Trip', secret = h.financeSecret) => {
    const method = service[name],
      metadata = new Metadata();
    metadata.set('x-caller-service', caller);
    metadata.set('x-service-secret', secret);
    metadata.set('x-correlation-id', randomUUID());
    return new Promise((resolve, reject) =>
      rpcClient.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        input,
        metadata,
        { deadline: Date.now() + 5000 },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
  };
  const destination = {
    destination_type: 'VIETQR',
    bank_code: 'TEST',
    account_number: '000987654321',
    account_name: 'PRIVATE WRITE HOLDER',
    is_default: true,
    active: true,
  };
  const enableBody = (user = holder) => ({ holder_user_id: user.id, currency: 'VND', destination });
  const newTrip = async () => {
    const result = await request(
      '/api/v1/trips',
      'POST',
      tripBody('Fund write tests'),
      bearer(owner),
    );
    assert.equal(result.status, 201);
    const id = result.body.data.id;
    await query(
      'trip',
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
      [id, holder.id],
    );
    return id;
  };
  const post = (path, body, user = owner, key = randomUUID()) =>
    request(path, 'POST', body, { ...bearer(user), 'idempotency-key': key });
  const write = async (path, body, user = owner, key = randomUUID()) => {
    const result = await post(path, body, user, key);
    if (result.status !== 202) return result;
    assert.equal(result.body.data.operation_id, key);
    await waitFor(async () => {
      const polled = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      assert.equal(polled.status, 200);
      return ['SUCCEEDED', 'FAILED'].includes(polled.body.data.state);
    });
    return post(path, body, user, key);
  };
  if (h.instructionsOnly) {
    try {
      return { forbidden: await runPaymentInstructionTests(h, { newTrip, write, enableBody }) };
    } finally {
      tripClient.onApplicationShutdown();
      rpcClient.close();
    }
  }
  if (h.receiptsOnly) {
    try {
      return {
        forbidden: await runFinanceReceiptTests(h, { newTrip, write, enableBody, financeDb }),
      };
    } finally {
      tripClient.onApplicationShutdown();
      rpcClient.close();
    }
  }
  const prepare = async (tripId, operationId = randomUUID()) => {
    const command = {
      scope: 'ENABLE_FUND',
      actor: owner.id,
      tripId,
      body: parseEnableFundInput(enableBody()),
    };
    const input = { ...command, operationId, hash: fundCommandHash(command) };
    const begin = {
      operation_id: operationId,
      trip_id: tripId,
      actor: { actor_user_id: owner.id },
      command: input.scope,
      request_hash: input.hash,
    };
    const guard = await tripClient.call(
      'BeginFinanceOperation',
      begin,
      randomUUID(),
      Date.now() + 5000,
    );
    return {
      input,
      guard,
      begin,
      cancel: {
        operation_id: operationId,
        request_hash: input.hash,
        command_scope: input.scope,
        authorization_context: guard.context,
      },
    };
  };
  const pollTerminal = async (id) =>
    waitFor(async () => {
      const rows = await query('trip', 'SELECT state FROM trip_operations WHERE operation_id=$1', [
        id,
      ]);
      return rows[0] && ['SUCCEEDED', 'FAILED'].includes(rows[0].state) ? rows[0].state : false;
    });
  try {
    const tripId = await newTrip(),
      path = `/api/v1/trips/${tripId}/fund`,
      key = randomUUID();
    assert.equal((await request(path, 'POST', enableBody())).status, 401);
    assert.equal((await request(path, 'POST', enableBody(), bearer(owner))).status, 400);
    assert.equal((await post(path, { ...enableBody(), actor_user_id: owner.id })).status, 400);
    assert.equal(
      (await post(path, { ...enableBody(), destination: { ...destination, active: 'true' } }))
        .status,
      400,
    );
    assert.equal((await post(path, { ...enableBody(), budget_amount: null })).status, 400);
    await assert.rejects(
      () =>
        tripClient.call(
          'BeginFinanceOperation',
          {
            operation_id: randomUUID(),
            trip_id: tripId,
            actor: { actor_user_id: outsider.id },
            command: 'ENABLE_FUND',
            request_hash: 'a'.repeat(64),
          },
          randomUUID(),
          Date.now() + 5000,
        ),
      (error) => {
        assert.equal(error.code, 5, `Trip Begin denial: ${error.details}`);
        return true;
      },
    );
    const localCommands = new FundCommandService(
      repo,
      new FundRepository(financeDb),
      {},
      tripClient,
    );
    await assert.rejects(
      () =>
        localCommands.enable(
          {
            ...enableBody(),
            operation_id: randomUUID(),
            actor_user_id: outsider.id,
            trip_id: tripId,
          },
          randomUUID(),
          Date.now() + 5000,
        ),
      (error) => {
        assert.equal(
          error.code,
          'RESOURCE_NOT_FOUND',
          `Finance command denial: ${error.name}: ${error.message}`,
        );
        return true;
      },
    );
    assert.equal((await post(path, enableBody(), outsider)).status, 404);
    assert.equal((await post(path, enableBody(), holder)).status, 403);
    assert.equal((await query('finance', 'SELECT count(*) AS n FROM command_receipts'))[0].n, '0');
    pass(
      'Fund writes reject invalid JSON, forged authority, missing session/key and unauthorized actors',
    );

    const enabled = await write(path, enableBody(), owner, key);
    assert.equal(enabled.status, 201, JSON.stringify(enabled.body));
    const fund = enabled.body.data;
    assert.equal(fund.status, 'OPEN');
    assert.equal(fund.current_balance, '0');
    assert.equal(fund.finance_version, 1);
    const destPath = `/api/v1/funds/${fund.id}/destinations`;
    let list = await request(destPath, 'GET', undefined, bearer(holder));
    const dest = list.body.data[0],
      confirmPath = `${destPath}/${dest.id}/confirm`;
    assert.equal(dest.confirmed_by_holder_at, null);
    assert.equal(dest.version, 1);
    assert.deepEqual((await write(path, enableBody(), owner, key)).body.data, fund);
    assert.equal(
      (await post(path, { ...enableBody(), budget_amount: '1' }, owner, key)).status,
      409,
    );
    assert.equal(
      (await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(outsider))).status,
      404,
    );
    pass(
      'Enable creates one zero-balance OPEN Fund and unconfirmed destination; replay is stable and scoped',
    );

    const versions = { expected_version: 1, expected_finance_version: 1 };
    assert.equal((await write(confirmPath, versions, owner)).status, 403);
    assert.equal(
      (await write(confirmPath, { ...versions, expected_version: 99 }, holder)).status,
      409,
    );
    const confirmKey = randomUUID();
    const confirmed = await write(confirmPath, versions, holder, confirmKey);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.version, 2);
    assert(confirmed.body.data.confirmed_by_holder_at);
    assert.deepEqual(
      (await write(confirmPath, versions, holder, confirmKey)).body.data,
      confirmed.body.data,
    );
    const audits = (
      await query('finance', 'SELECT count(*) AS n FROM finance_audit_logs WHERE fund_id=$1', [
        fund.id,
      ])
    )[0].n;
    assert.deepEqual(
      (await write(confirmPath, { expected_version: 2, expected_finance_version: 2 }, holder)).body
        .data,
      confirmed.body.data,
    );
    assert.equal(
      (
        await query('finance', 'SELECT count(*) AS n FROM finance_audit_logs WHERE fund_id=$1', [
          fund.id,
        ])
      )[0].n,
      audits,
    );
    assert.equal(
      (await request(path, 'GET', undefined, bearer(owner))).body.data.finance_version,
      2,
    );
    assert.equal((await write(confirmPath, versions, holder)).status, 409);
    await query('finance', 'UPDATE funds SET finance_version=2147483647 WHERE id=$1', [fund.id]);
    await query(
      'finance',
      'UPDATE payment_destinations SET confirmed_by_holder_at=NULL WHERE id=$1',
      [dest.id],
    );
    assert.equal(
      (
        await write(
          confirmPath,
          { expected_version: 2, expected_finance_version: 2147483647 },
          holder,
        )
      ).status,
      409,
    );
    await query('finance', 'UPDATE funds SET finance_version=2 WHERE id=$1', [fund.id]);
    pass(
      'Only Holder confirms; versions increment once, stale/overflow rejected, replay and no-op do not mutate',
    );

    const selfTrip = await newTrip(),
      selfPath = `/api/v1/trips/${selfTrip}/fund`;
    const races = await Promise.all([
      write(selfPath, enableBody(owner)),
      write(selfPath, enableBody(owner)),
    ]);
    assert.deepEqual(races.map((r) => r.status).sort(), [201, 409]);
    const selfFund = races.find((r) => r.status === 201).body.data;
    list = await request(
      `/api/v1/funds/${selfFund.id}/destinations`,
      'GET',
      undefined,
      bearer(owner),
    );
    assert.equal(list.body.data[0].confirmed_by_holder_at, null);
    assert.equal(
      (await query('finance', 'SELECT count(*) AS n FROM funds WHERE trip_id=$1', [selfTrip]))[0].n,
      '1',
    );
    pass('Concurrent enable permits one Fund; Owner=Holder still requires explicit confirmation');

    const heldTrip = await newTrip();
    const invitation = await request(
      `/api/v1/trips/${heldTrip}/invitations`,
      'POST',
      { invitation_type: 'LINK', expected_membership_revision: 1 },
      { ...bearer(owner), 'idempotency-key': randomUUID() },
    );
    assert.equal(invitation.status, 201);
    const token = new URLSearchParams(
      new URL(invitation.body.data.one_time_link).hash.slice(1),
    ).get('token');
    const held = await prepare(heldTrip);
    await assert.rejects(
      () => prepare(heldTrip),
      (error) => error.code === 9,
    );
    assert.equal((await post('/api/v1/invitations/accept', { token }, outsider)).status, 409);
    const memberships = new MembershipRepository(tripDb);
    const revision = (
      await query('trip', 'SELECT membership_revision FROM trips WHERE id=$1', [heldTrip])
    )[0].membership_revision;
    await assert.rejects(
      () =>
        memberships.prepare(
          {
            operationId: randomUUID(),
            actorUserId: holder.id,
            tripId: heldTrip,
            reason: 'guard regression',
            expectedRevision: revision,
            command: 'LEAVE_MEMBER',
          },
          randomUUID(),
          true,
        ),
      (error) => error.code === 'STATE_CONFLICT',
    );
    const cancelled = await rpc('CancelOperationIfNotCommitted', held.cancel);
    assert.equal(cancelled.receipt.outcome.status, 3);
    assert.equal((await repo.execute(held.input, held.guard, randomUUID())).status, 'CANCELLED');
    assert.equal(
      (await query('finance', 'SELECT count(*) AS n FROM funds WHERE trip_id=$1', [heldTrip]))[0].n,
      '0',
    );
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      held.input.operationId,
    ]);
    assert.equal(await pollTerminal(held.input.operationId), 'FAILED');
    assert.equal((await post('/api/v1/invitations/accept', { token }, outsider)).status, 200);
    pass(
      'Durable Finance guard blocks another write, invitation acceptance and membership leave; cancel fences late execution',
    );

    const committedTrip = await newTrip(),
      committed = await prepare(committedTrip);
    const committedRow = await repo.execute(committed.input, committed.guard, randomUUID());
    assert.equal(committedRow.status, 'COMMITTED');
    assert.equal(
      (await rpc('CancelOperationIfNotCommitted', committed.cancel)).receipt.outcome.status,
      1,
    );
    const receipt = await rpc('GetOperationResult', { operation_id: committed.input.operationId });
    assert(!JSON.stringify(receipt).includes(destination.account_number));
    assert(!JSON.stringify(receipt).includes(destination.account_name));
    await assert.rejects(
      () =>
        rpc(
          'GetOperationResult',
          { operation_id: committed.input.operationId },
          'ApiGateway',
          h.gatewaySecret,
        ),
      (error) => error.code === 7,
    );
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      committed.input.operationId,
    ]);
    await h.restartTrip();
    assert.equal(await pollTerminal(committed.input.operationId), 'SUCCEEDED');
    const recovered = await write(
      `/api/v1/trips/${committedTrip}/fund`,
      enableBody(),
      owner,
      committed.input.operationId,
    );
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.data.id, committedRow.response.fund.id);
    pass(
      'Finance commit survives lost Complete and Trip restart; recovery returns same result without exposing bank fields',
    );

    const unknownTrip = await newTrip(),
      unknown = await prepare(unknownTrip);
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      unknown.input.operationId,
    ]);
    assert.equal(await pollTerminal(unknown.input.operationId), 'FAILED');
    assert.equal((await repo.find(unknown.input.operationId)).status, 'CANCELLED');
    assert.equal(
      (await repo.execute(unknown.input, unknown.guard, randomUUID())).status,
      'CANCELLED',
    );
    pass(
      'Lost Begin response/no Finance receipt recovers through NOT_FOUND and terminal cancellation',
    );

    const raceTrip = await newTrip(),
      racing = await prepare(raceTrip);
    const race = await Promise.all([
      repo.execute(racing.input, racing.guard, randomUUID()),
      repo.cancel(racing.cancel),
    ]);
    assert.equal(race[0].status, race[1].status);
    assert(['COMMITTED', 'CANCELLED'].includes(race[0].status));
    assert.equal(
      (
        await query('finance', 'SELECT count(*) AS n FROM command_receipts WHERE operation_id=$1', [
          racing.input.operationId,
        ])
      )[0].n,
      '1',
    );
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      racing.input.operationId,
    ]);
    await pollTerminal(racing.input.operationId);
    pass('Concurrent execute/cancel has exactly one terminal receipt and one business outcome');

    const rollbackTrip = await newTrip(),
      rollback = await prepare(rollbackTrip);
    const broken = new FundCommandRepository({
      ...financeDb,
      withTransaction: (work) =>
        transaction('finance', (client) =>
          work({
            query: (sql, args) => {
              if (sql.includes('INSERT INTO finance_audit_logs'))
                throw new Error('Injected audit failure');
              return client.query(sql, args);
            },
          }),
        ),
    });
    await assert.rejects(
      () => broken.execute(rollback.input, rollback.guard, randomUUID()),
      /Injected/,
    );
    assert.equal(await repo.find(rollback.input.operationId), undefined);
    assert.equal(
      (
        await query('finance', 'SELECT count(*) AS n FROM funds WHERE trip_id=$1', [rollbackTrip])
      )[0].n,
      '0',
    );
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      rollback.input.operationId,
    ]);
    await pollTerminal(rollback.input.operationId);
    pass('Audit failure rolls back Fund, destination and receipt in the same transaction');

    const pendingTrip = await newTrip();
    const commandService = new FundCommandService(
      repo,
      new FundRepository(financeDb),
      {},
      {
        call: (method, ...args) =>
          method === 'CompleteOperation'
            ? Promise.reject(new Error('Injected lost Complete'))
            : tripClient.call(method, ...args),
      },
    );
    const pendingKey = randomUUID();
    const pending = await commandService.enable(
      { ...enableBody(), trip_id: pendingTrip, actor_user_id: owner.id, operation_id: pendingKey },
      randomUUID(),
      Date.now() + 5000,
    );
    assert.equal(pending.operation.state, 2);
    assert.equal(pending.operation.operation_id, pendingKey);
    const polling = await request(
      `/api/v1/operations/${pendingKey}`,
      'GET',
      undefined,
      bearer(owner),
    );
    assert.equal(polling.status, 200);
    assert(!JSON.stringify(polling.body).includes(destination.account_number));
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      pendingKey,
    ]);
    await pollTerminal(pendingKey);
    pass(
      'Lost Complete produces a pollable pending operation and recovery finalizes the committed write',
    );

    const failureTrip = await newTrip(),
      failure = await prepare(failureTrip);
    const unavailable = {
      recoverOperation: async () => {
        throw new Error('Unavailable');
      },
    };
    const workers = [
      new FinanceOperationService(new MembershipRepository(tripDb), unavailable),
      new FinanceOperationService(new MembershipRepository(tripDb), unavailable),
    ];
    await h.whileTripStopped(async () => {
      await query(
        'trip',
        'UPDATE trip_operations SET retry_count=4,next_retry_at=now() WHERE operation_id=$1',
        [failure.input.operationId],
      );
      await Promise.all(workers.map((worker) => worker.recoverDue()));
      const failed = (
        await query('trip', 'SELECT state,retry_count FROM trip_operations WHERE operation_id=$1', [
          failure.input.operationId,
        ])
      )[0];
      assert.equal(failed.state, 'NEEDS_REVIEW');
      assert.equal(failed.retry_count, 5);
    });
    await assert.rejects(
      () => prepare(failureTrip),
      (error) => error.code === 9,
    );
    await rpc('CancelOperationIfNotCommitted', failure.cancel);
    // Administrative retry method only schedules recovery; it never releases the guard.
    await workers[0].retryNeedsReview(failure.input.operationId, true);
    assert.equal(await pollTerminal(failure.input.operationId), 'FAILED');
    pass(
      'Competing recovery workers respect bounded retries; NEEDS_REVIEW keeps guard until terminal recovery',
    );

    await runFinanceConfigurationTests(h, {
      newTrip,
      write,
      enableBody,
      destination,
      repo,
      tripClient,
      pollTerminal,
      financeDb,
    });
    for (const table of ['fund_transactions', 'outbox_events'])
      assert.equal((await query('finance', `SELECT count(*) AS n FROM ${table}`))[0].n, '0');
    const tripOperations = await query(
      'trip',
      "SELECT command_payload,outcome FROM trip_operations WHERE operation_type IN ('ENABLE_FUND','CONFIRM_PAYMENT_DESTINATION','UPDATE_FUND_BUDGET','CREATE_PAYMENT_DESTINATION','UPDATE_PAYMENT_DESTINATION')",
    );
    const auditsAll = await query('finance', 'SELECT details FROM finance_audit_logs');
    for (const value of [tripOperations, auditsAll]) {
      assert(!JSON.stringify(value).includes(destination.account_number));
      assert(!JSON.stringify(value).includes(destination.account_name));
    }
    pass(
      'Setup/confirmation create no ledger or invented events; Trip intents and audit contain no bank details',
    );
    await runContributionRequestTests(h, {
      newTrip,
      write,
      enableBody,
      repo,
      tripClient,
      pollTerminal,
      financeDb,
    });
    await runContributionManagementTests(h, {
      newTrip,
      write,
      enableBody,
      repo,
      tripClient,
      pollTerminal,
      financeDb,
    });
    const receiptKeys = await runFinanceReceiptTests(h, { newTrip, write, enableBody, financeDb });
    const manualKeys = await runManualContributionTests(h, {
      newTrip,
      write,
      enableBody,
      repo,
      tripClient,
      pollTerminal,
      financeDb,
    });
    await runContributionReversalTests(h, {
      newTrip,
      write,
      enableBody,
      pollTerminal,
    });
    const instructionKeys = await runPaymentInstructionTests(h, { newTrip, write, enableBody });
    return {
      forbidden: [
        ...instructionKeys,
        ...receiptKeys,
        ...manualKeys,
        owner.access,
        holder.access,
        outsider.access,
        destination.account_number,
        destination.account_name,
      ],
    };
  } finally {
    tripClient.onApplicationShutdown();
    rpcClient.close();
  }
}
