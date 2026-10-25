import { withPriceWatchTransaction } from './price-watch-transaction';
import { Injectable } from '@nestjs/common';
import type { parseEventForConsume } from '@wolfari/contracts/events';
import { DatabaseProvider } from '@wolfari/database';

type WolfariEventV1 = ReturnType<typeof parseEventForConsume>;

type LifecycleEventType =
  'MemberLeft' | 'MemberRemoved' | 'TripArchived' | 'TripDeleted' | 'TripReopened';

type LifecycleState = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

function eventType(event: WolfariEventV1): LifecycleEventType {
  if (
    !['MemberLeft', 'MemberRemoved', 'TripArchived', 'TripDeleted', 'TripReopened'].includes(
      event.event_type,
    )
  )
    throw new Error('UNSUPPORTED_PRICE_WATCH_LIFECYCLE_EVENT');
  return event.event_type as LifecycleEventType;
}

function payloadValue(event: WolfariEventV1, key: string): string | number {
  const value = event.payload[key];
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('INVALID_PRICE_WATCH_LIFECYCLE_EVENT');
  return value;
}

async function reconcile(client: Pick<DatabaseProvider, 'query'>, groups: string[]): Promise<void> {
  if (!groups.length) return;
  await client.query(
    `WITH target AS (SELECT DISTINCT unnest($1::uuid[]) AS id), state AS (
       SELECT target.id,EXISTS(
         SELECT 1 FROM price_watches w
         WHERE w.query_group_id=target.id AND w.status='ACTIVE'
           AND w.expires_at>clock_timestamp()
       ) AS has_active FROM target
     )
     UPDATE price_query_groups q SET active=state.has_active,
       next_check_at=CASE
         WHEN state.has_active AND q.next_check_at IS NULL THEN clock_timestamp()
         WHEN state.has_active THEN q.next_check_at
         ELSE NULL
       END,updated_at=clock_timestamp()
     FROM state WHERE q.id=state.id`,
    [groups],
  );
}

@Injectable()
export class PriceWatchLifecycleRepository {
  constructor(private readonly database: DatabaseProvider) {}

  async apply(event: WolfariEventV1): Promise<'APPLIED' | 'DUPLICATE' | 'STALE'> {
    const type = eventType(event);
    return withPriceWatchTransaction(this.database, async (client) => {
      const inbox = await client.query(
        `INSERT INTO inbox_events(
           consumer_name,event_id,event_type,aggregate_id,aggregate_version
         ) VALUES('AutomationPriceWatchLifecycle',$1,$2,$3,$4)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.event_id, type, event.aggregate_id, event.aggregate_version],
      );
      if (!inbox.rowCount) return 'DUPLICATE';

      let changed: Array<{ id: string; query_group_id: string }> = [];
      if (type === 'MemberLeft' || type === 'MemberRemoved') {
        const exhausted = await client.query(
          `SELECT id FROM price_watches
           WHERE owner_membership_id=$1 AND status IN ('ACTIVE','PAUSED')
             AND version>=2147483647 FOR UPDATE`,
          [event.aggregate_id],
        );
        if (exhausted.rowCount) throw new Error('PRICE_WATCH_VERSION_EXHAUSTED');
        changed = (
          await client.query<{ id: string; query_group_id: string }>(
            `UPDATE price_watches SET status='STOPPED',status_reason=$2,
               alert_armed=false,version=version+1,updated_at=clock_timestamp()
             WHERE owner_membership_id=$1 AND status IN ('ACTIVE','PAUSED')
             RETURNING id,query_group_id`,
            [event.aggregate_id, type === 'MemberLeft' ? 'MEMBER_LEFT' : 'MEMBER_REMOVED'],
          )
        ).rows;
      } else {
        const tripId = String(payloadValue(event, 'trip_id'));
        const revision = Number(payloadValue(event, 'export_revision'));
        const state: LifecycleState =
          type === 'TripArchived' ? 'ARCHIVED' : type === 'TripDeleted' ? 'DELETED' : 'ACTIVE';
        const accepted = await client.query(
          `INSERT INTO price_watch_trip_lifecycle(
             trip_id,export_revision,state,event_id,updated_at
           ) VALUES($1,$2,$3,$4,clock_timestamp())
           ON CONFLICT(trip_id) DO UPDATE SET
             export_revision=EXCLUDED.export_revision,state=EXCLUDED.state,
             event_id=EXCLUDED.event_id,updated_at=clock_timestamp()
           WHERE price_watch_trip_lifecycle.export_revision<EXCLUDED.export_revision
             AND (price_watch_trip_lifecycle.state<>'DELETED' OR EXCLUDED.state='DELETED')
           RETURNING trip_id`,
          [tripId, revision, state, event.event_id],
        );
        if (!accepted.rowCount) return 'STALE';
        if (type !== 'TripReopened') {
          const statuses = type === 'TripArchived' ? ['ACTIVE'] : ['ACTIVE', 'PAUSED'];
          const exhausted = await client.query(
            `SELECT id FROM price_watches
             WHERE trip_id=$1 AND status=ANY($2::varchar[]) AND version>=2147483647
             FOR UPDATE`,
            [tripId, statuses],
          );
          if (exhausted.rowCount) throw new Error('PRICE_WATCH_VERSION_EXHAUSTED');
          changed = (
            await client.query<{ id: string; query_group_id: string }>(
              `UPDATE price_watches SET status=$3::varchar,status_reason=$4::varchar,
                 alert_armed=CASE WHEN $3::varchar='STOPPED' THEN false ELSE alert_armed END,
                 version=version+1,updated_at=clock_timestamp()
               WHERE trip_id=$1 AND status=ANY($2::varchar[])
               RETURNING id,query_group_id`,
              [
                tripId,
                statuses,
                type === 'TripArchived' ? 'PAUSED' : 'STOPPED',
                type === 'TripArchived' ? 'TRIP_ARCHIVED' : 'TRIP_DELETED',
              ],
            )
          ).rows;
        }
      }

      if (changed.length) {
        await client.query(
          `UPDATE price_alert_candidates SET status='SUPPRESSED',
             completed_at=clock_timestamp(),claim_owner=NULL,claim_until=NULL,
             last_error=$2,updated_at=clock_timestamp()
           WHERE watch_id=ANY($1::uuid[]) AND status IN ('PENDING','PROCESSING')`,
          [changed.map((row) => row.id), `LIFECYCLE_${type.toUpperCase()}`],
        );
        await reconcile(client, [...new Set(changed.map((row) => row.query_group_id))]);
      }
      return 'APPLIED';
    });
  }
}
