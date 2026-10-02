import { resolve } from 'node:path';
import pg from 'pg';
import { readEnv, root } from './config.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function main() {
  const [kind, id, reasonFlag, reason, ...rest] = process.argv.slice(2);
  if (
    !['--delivery-id', '--event-id'].includes(kind) ||
    !uuid.test(id ?? '') ||
    reasonFlag !== '--reason' ||
    !/^[A-Za-z0-9._-]{3,80}$/.test(reason ?? '') ||
    rest.length
  )
    throw new Error(
      'Usage: pnpm trip:replay-invitation <--delivery-id|--event-id> <uuid> --reason <ticket>',
    );
  const service = kind === '--delivery-id' ? 'automation' : 'trip';
  const env = await readEnv(
    process.env.WOLFARI_REPLAY_ENV_FILE ??
      resolve(root, `apps/${service === 'trip' ? 'trip-workspace' : service}-service/.env`),
  );
  if (env.NODE_ENV === 'production') throw new Error('Local replay disabled in production');
  const target = new URL(env.DATABASE_URL);
  if (
    target.hostname !== '127.0.0.1' ||
    target.pathname !== `/${service}_db` ||
    decodeURIComponent(target.username) !== `${service}_app`
  )
    throw new Error('Replay is limited to the matching local service database');
  const client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    const sql =
      kind === '--delivery-id'
        ? `UPDATE notification_deliveries SET status='PENDING',attempt_count=0,next_attempt_at=clock_timestamp(),claim_owner=NULL,claim_until=NULL,last_error=$2,updated_at=clock_timestamp()
      WHERE id=$1 AND channel='EMAIL' AND status='FAILED' AND last_error='DELIVERY_FAILED'
      AND notification_id IN (SELECT id FROM notifications WHERE type='TRIP_INVITATION') AND private_context ? 'invitation_id' RETURNING id`
        : `UPDATE outbox_events SET status='PENDING',attempt_count=0,next_attempt_at=clock_timestamp(),claim_owner=NULL,claim_until=NULL,last_error=$2
      WHERE event_id=$1 AND producer='Trip' AND event_type IN ('MemberInvited','MemberJoined') AND status IN ('FAILED','PUBLISHED') RETURNING event_id`;
    const result = await client.query(sql, [id, `OPERATOR_REPLAY:${reason}`]);
    if (result.rowCount !== 1) throw new Error('No replayable failed invitation record');
    console.log(`PASS queued existing ${kind.slice(2)} ${id}; no new invitation created.`);
  } finally {
    await client.end().catch(() => {});
  }
}
main().catch(() => {
  console.error(
    'Invitation replay failed. Check explicit ID, reason, local configuration and failed status.',
  );
  process.exitCode = 1;
});
