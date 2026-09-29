import { resolve } from 'node:path';
import pg from 'pg';
import { readEnv, root } from './config.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--delivery-id' || args[2] !== '--reason' || !uuid.test(args[1]) || !/^[A-Za-z0-9._-]{3,80}$/.test(args[3])) {
    throw new Error('Usage: pnpm identity:replay-email --delivery-id <uuid> --reason <ticket-or-short-code>');
  }
  const env = await readEnv(process.env.WOLFARI_REPLAY_ENV_FILE ?? resolve(root, 'apps/automation-service/.env'));
  if (env.NODE_ENV === 'production') throw new Error('Local replay command is disabled in production.');
  const target = new URL(env.DATABASE_URL);
  if (target.hostname !== '127.0.0.1' || target.pathname !== '/automation_db' || decodeURIComponent(target.username) !== 'automation_app') {
    throw new Error('Replay is limited to the local automation database.');
  }
  const client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    const updated = await client.query(`UPDATE notification_deliveries SET status='PENDING',attempt_count=0,
      next_attempt_at=now(),claim_owner=NULL,claim_until=NULL,last_error=$2,updated_at=now()
      WHERE id=$1 AND channel='EMAIL' AND status='FAILED' AND last_error='DELIVERY_FAILED'
        AND private_context ? 'token_id' RETURNING id`, [args[1], `OPERATOR_REPLAY:${args[3]}`]);
    if (updated.rowCount !== 1) throw new Error('No replayable failed email delivery with that ID.');
    console.log(`PASS queued email delivery ${args[1]} for controlled replay.`);
  } finally { await client.end().catch(() => {}); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Replay failed.');
  process.exitCode = 1;
});
