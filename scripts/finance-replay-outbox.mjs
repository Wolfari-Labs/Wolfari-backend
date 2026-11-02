import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readEnv, root } from './config.mjs';
import pg from 'pg';

const require = createRequire(import.meta.url);
const {
  FinanceOutboxRepository,
} = require('../apps/finance-service/dist/outbox/finance-outbox.repository.js');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const [flag, id, reasonFlag, reason, ...rest] = process.argv.slice(2);
  if (
    flag !== '--event-id' ||
    !uuid.test(id ?? '') ||
    reasonFlag !== '--reason' ||
    !/^[A-Za-z0-9._-]{3,80}$/.test(reason ?? '') ||
    rest.length
  )
    throw new Error('INVALID_REPLAY_ARGUMENTS');
  const env = await readEnv(
    process.env.WOLFARI_REPLAY_ENV_FILE ?? resolve(root, 'apps/finance-service/.env'),
  );
  if (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production')
    throw new Error('LOCAL_REPLAY_ONLY');
  const target = new URL(env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/finance_db' ||
    decodeURIComponent(target.username) !== 'finance_app' ||
    !target.password ||
    target.search ||
    target.hash
  )
    throw new Error('LOCAL_FINANCE_DATABASE_ONLY');
  const pool = new pg.Pool({
    connectionString: target.href,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  pool.on('error', () => {});
  try {
    const client = await pool.connect();
    let discard = true;
    try {
      const {
        rows: [identity],
      } = await client.query({
        text: 'SELECT current_database() AS db, current_user AS role',
        query_timeout: 5000,
      });
      if (identity?.db !== 'finance_db' || identity?.role !== 'finance_app')
        throw new Error('WRONG_DATABASE_OR_ROLE');
      discard = false;
    } finally {
      client.release(discard);
    }
    const repository = new FinanceOutboxRepository({ pool });
    if (!(await repository.replayFailed(id, reason))) throw new Error('EVENT_NOT_REPLAYABLE');
    console.log(`PASS queued existing Finance event ${id.toLowerCase()} for controlled replay.`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch(() => {
  console.error(
    'Finance outbox replay failed. Check explicit UUID, reason, local Finance configuration and valid FAILED event.',
  );
  process.exitCode = 1;
});
