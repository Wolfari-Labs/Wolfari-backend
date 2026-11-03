import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pg from 'pg';
import { readEnv, root } from './config.mjs';
import { loadDemo } from './demo-config.mjs';
const require = createRequire(import.meta.url);
const {
  MembershipRepository,
} = require('../apps/trip-workspace-service/dist/membership/membership.repository.js');
const {
  FinanceOperationService,
} = require('../apps/trip-workspace-service/dist/operations/finance-operation.service.js');
const args = process.argv.slice(2),
  execute = args.includes('--execute');
const id = args.find((arg) => !arg.startsWith('--'));
if (
  !id ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
  args.some((arg) => arg !== id && arg !== '--execute' && arg !== '--demo')
)
  throw new Error(
    'Usage: pnpm trip:retry-finance <operation-id> [--demo] [--execute]; default dry-run',
  );
const env = args.includes('--demo')
  ? (await loadDemo()).configs['trip-workspace-service']
  : await readEnv(resolve(root, 'apps/trip-workspace-service/.env'));
const { databaseConfig } = require('../packages/database/dist/index.js');
const pool = new pg.Pool(databaseConfig(env, 'trip'));
const db = {
  query: (sql, args) => pool.query(sql, args),
  withTransaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};
try {
  // No worker lifecycle is started here. The running Trip service performs recovery.
  const service = new FinanceOperationService(new MembershipRepository(db), undefined);
  const operation = await service.retryNeedsReview(id, execute);
  console.log(JSON.stringify({ mode: execute ? 'retry-scheduled' : 'dry-run', operation }));
} finally {
  await pool.end();
}
