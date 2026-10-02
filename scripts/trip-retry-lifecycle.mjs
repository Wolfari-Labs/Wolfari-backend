import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pg from 'pg';
import { readEnv, root } from './config.mjs';
const require = createRequire(import.meta.url);
const {
  MembershipRepository,
} = require('../apps/trip-workspace-service/dist/membership/membership.repository.js');
const {
  operationView,
} = require('../apps/trip-workspace-service/dist/membership/membership.domain.js');
const args = process.argv.slice(2),
  execute = args.includes('--execute');
const operationId = args.find((arg) => !arg.startsWith('--'));
if (
  !operationId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId) ||
  args.some((arg) => arg !== operationId && arg !== '--execute')
)
  throw new Error('Usage: pnpm trip:retry-lifecycle <operation-id> [--execute]; default dry-run');
const env = await readEnv(resolve(root, 'apps/trip-workspace-service/.env'));
const { databaseConfig } = require('../packages/database/dist/index.js');
const pool = new pg.Pool(databaseConfig(env, 'trip'));
const db = {
  query: (sql, values) => pool.query(sql, values),
  withTransaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
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
try {
  const row = await new MembershipRepository(db).retryNeedsReview(operationId, execute);
  if (execute) console.log(`LIFECYCLE_MANUAL_RETRY operation_id=${row.operation_id}`);
  console.log(
    JSON.stringify({
      mode: execute ? 'retry-scheduled' : 'dry-run',
      operation: operationView(row),
    }),
  );
} finally {
  await pool.end();
}
