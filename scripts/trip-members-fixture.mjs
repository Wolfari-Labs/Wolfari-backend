// Test-only Finance protocol fixture. This is NOT Finance business implementation.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../packages/contracts/package.json', import.meta.url));
const { Server, ServerCredentials, status } = require('@grpc/grpc-js');
const { loadSync } = require('@grpc/proto-loader');
const { PROTO_PATHS, GRPC_LOADER_OPTIONS } = require('../contracts/dist/grpc.js');
export async function startLifecycleFinanceFixture({ port, secret, query, transaction }) {
  await query(
    'finance',
    `CREATE TABLE test_lifecycle_receipts(operation_id uuid PRIMARY KEY, request_hash text NOT NULL, receipt jsonb NOT NULL)`,
  );
  const modes = new Map(),
    calls = [];
  let gate;
  let getGate;
  const server = new Server();
  const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
    'wolfari.finance.v1.FinanceService'
  ];
  async function receipt(request, cancel) {
    return transaction('finance', async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        request.operation_id,
      ]);
      const previous = (
        await client.query('SELECT * FROM test_lifecycle_receipts WHERE operation_id=$1', [
          request.operation_id,
        ])
      ).rows[0];
      if (previous) {
        assert.equal(previous.request_hash, request.request_hash);
        return previous.receipt;
      }
      assert.ok(request.membership_target.membership_id);
      assert.ok(
        request.authorization_context.active_user_ids.includes(request.membership_target.user_id),
      );
      const mode = modes.get(request.authorization_context.trip_id);
      const result = {
        operation_id: request.operation_id,
        request_hash: request.request_hash,
        outcome: {
          status: cancel ? 3 : mode === 'reject' ? 2 : 1,
          ...(mode === 'reject' && !cancel ? { error_code: 'FINANCE_OBLIGATION_BLOCKED' } : {}),
        },
        completed_at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
      };
      await client.query('INSERT INTO test_lifecycle_receipts VALUES($1,$2,$3::jsonb)', [
        request.operation_id,
        request.request_hash,
        JSON.stringify(result),
      ]);
      return result;
    });
  }
  const wrap = (work) => async (call, callback) => {
    if (
      call.metadata.get('x-caller-service')[0] !== 'Trip' ||
      call.metadata.get('x-service-secret')[0] !== secret ||
      !/^[0-9a-f-]{36}$/.test(String(call.metadata.get('x-correlation-id')[0]))
    )
      return callback({ code: status.PERMISSION_DENIED });
    try {
      callback(null, await work(call.request));
    } catch {
      callback({ code: status.UNAVAILABLE, details: 'fixture outage' });
    }
  };
  server.addService(service, {
    ExecuteTripOperation: wrap(async (request) => {
      calls.push({ method: 'execute', request });
      if (gate) {
        const current = gate;
        gate = undefined;
        current.entered(request);
        await current.wait;
      }
      const mode = modes.get(request.authorization_context.trip_id);
      if (mode === 'unavailable') throw new Error();
      const result = await receipt(request, false);
      if (mode === 'lost-response') throw new Error();
      return { receipt: result };
    }),
    GetOperationResult: wrap(async (request) => {
      calls.push({ method: 'get', request });
      const found = (
        await query(
          'finance',
          'SELECT receipt FROM test_lifecycle_receipts WHERE operation_id=$1',
          [request.operation_id],
        )
      )[0];
      if (!found && getGate) {
        const current = getGate;
        getGate = undefined;
        current.entered();
        await current.wait;
      }
      return found ? { receipt: found.receipt } : { not_found: {} };
    }),
    CancelOperationIfNotCommitted: wrap(async (request) => {
      calls.push({ method: 'cancel', request });
      return { receipt: await receipt(request, true) };
    }),
  });
  await new Promise((resolve, reject) =>
    server.bindAsync(`127.0.0.1:${port}`, ServerCredentials.createInsecure(), (e) =>
      e ? reject(e) : resolve(),
    ),
  );
  return {
    modes,
    calls,
    close: () => new Promise((resolve) => server.tryShutdown(resolve)),
    holdNext() {
      let entered, release;
      const reached = new Promise((r) => {
        entered = r;
      });
      gate = {
        entered,
        wait: new Promise((r) => {
          release = r;
        }),
      };
      return { reached, release };
    },
    // Used to prove a late Execute cannot override cancellation in the same durable store.
    lateExecute: (request) => receipt(request, false),
    holdNotFound() {
      let entered, release;
      const reached = new Promise((r) => {
        entered = r;
      });
      getGate = {
        entered,
        wait: new Promise((r) => {
          release = r;
        }),
      };
      return { reached, release };
    },
  };
}
