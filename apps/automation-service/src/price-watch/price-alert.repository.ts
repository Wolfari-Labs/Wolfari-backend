import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import {
  PRICE_ALERT_MAX_ATTEMPTS,
  evaluatePriceAlert,
  priceAlertRetryDelay,
} from './price-alert.domain';

type Queryable = Pick<DatabaseProvider, 'query'>;

interface WatchAlertRow {
  id: string;
  version: number;
  threshold_price: string;
  last_alert_price: string | null;
  last_alert_at: Date | string | null;
  alert_armed: boolean;
}

export interface AlertObservation {
  id: string;
  queryGroupId: string;
  price: string;
  observedAt: Date;
}

export interface ClaimedPriceAlert {
  id: string;
  watch_id: string;
  observation_id: string;
  watch_version: number;
  attempt_count: number;
  user_id: string;
  trip_id: string;
  owner_membership_id: string;
}

interface CandidateDetailRow extends ClaimedPriceAlert {
  status: string;
  claim_owner: string | null;
  query_group_id: string;
  watch_status: string;
  version: number;
  threshold_price: string;
  expires_at: Date | string;
  last_alert_price: string | null;
  last_alert_at: Date | string | null;
  alert_armed: boolean;
  observation_query_group_id: string;
  price: string;
  observed_at: Date | string;
}

export type AlertCompletion = 'NOTIFIED' | 'SUPPRESSED' | 'SUPERSEDED' | 'FAILED' | 'STALE';

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function reconcileQueryGroup(client: Queryable, queryGroupId: string): Promise<void> {
  await client.query(
    `WITH state AS (
       SELECT EXISTS(
         SELECT 1 FROM price_watches
         WHERE query_group_id=$1 AND status='ACTIVE' AND expires_at>clock_timestamp()
       ) AS has_active
     )
     UPDATE price_query_groups q SET active=state.has_active,
       next_check_at=CASE
         WHEN state.has_active AND q.next_check_at IS NULL THEN clock_timestamp()
         WHEN state.has_active THEN q.next_check_at
         ELSE NULL
       END,
       updated_at=clock_timestamp()
     FROM state WHERE q.id=$1`,
    [queryGroupId],
  );
}

export async function recordPriceAlertCandidates(
  client: Queryable,
  observation: AlertObservation,
): Promise<void> {
  const watches = (
    await client.query<WatchAlertRow>(
      `SELECT id,version,threshold_price::text,last_alert_price::text,last_alert_at,alert_armed
       FROM price_watches
       WHERE query_group_id=$1 AND status='ACTIVE' AND expires_at>$2
       ORDER BY id FOR UPDATE`,
      [observation.queryGroupId, observation.observedAt],
    )
  ).rows;
  for (const watch of watches) {
    await client.query(
      `UPDATE price_alert_candidates SET status='SUPERSEDED',completed_at=$2,
         claim_owner=NULL,claim_until=NULL,last_error='NEWER_OBSERVATION',updated_at=$2
       WHERE watch_id=$1 AND status IN ('PENDING','PROCESSING')`,
      [watch.id, observation.observedAt],
    );
    const decision = evaluatePriceAlert({
      price: observation.price,
      thresholdPrice: String(watch.threshold_price),
      lastAlertPrice: watch.last_alert_price === null ? null : String(watch.last_alert_price),
      lastAlertAt: watch.last_alert_at,
      alertArmed: watch.alert_armed,
      evaluatedAt: observation.observedAt,
    });
    if (decision.rearm && !watch.alert_armed) {
      await client.query(
        `UPDATE price_watches SET alert_armed=true,updated_at=$2
         WHERE id=$1 AND version=$3 AND status='ACTIVE'`,
        [watch.id, observation.observedAt, watch.version],
      );
    }
    if (!decision.reason) continue;
    await client.query(
      `INSERT INTO price_alert_candidates(
         watch_id,observation_id,watch_version,reason,next_attempt_at,created_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$5,$5)
       ON CONFLICT(watch_id,observation_id) DO NOTHING`,
      [watch.id, observation.id, watch.version, decision.reason, observation.observedAt],
    );
  }
}

@Injectable()
export class PriceAlertRepository {
  constructor(private readonly database: DatabaseProvider) {}

  async failExhaustedLeases(batchSize: number): Promise<number> {
    const result = await this.database.query(
      `WITH exhausted AS (
         SELECT id FROM price_alert_candidates
         WHERE status='PROCESSING' AND claim_until<clock_timestamp()
           AND attempt_count>=$1
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE price_alert_candidates c SET status='FAILED',completed_at=clock_timestamp(),
         claim_owner=NULL,claim_until=NULL,last_error='ACCESS_RETRY_EXHAUSTED',
         updated_at=clock_timestamp()
       FROM exhausted e WHERE c.id=e.id`,
      [PRICE_ALERT_MAX_ATTEMPTS, batchSize],
    );
    return result.rowCount ?? 0;
  }

  async claimNext(owner: string, leaseMs: number): Promise<ClaimedPriceAlert | undefined> {
    const result = await this.database.query<ClaimedPriceAlert>(
      `WITH candidate AS (
         SELECT id FROM price_alert_candidates
         WHERE attempt_count<$3 AND (
           (status='PENDING' AND next_attempt_at<=clock_timestamp()) OR
           (status='PROCESSING' AND claim_until<clock_timestamp())
         )
         ORDER BY next_attempt_at,created_at,id
         FOR UPDATE SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE price_alert_candidates c SET status='PROCESSING',claim_owner=$1,
           claim_until=clock_timestamp()+($2::int*interval '1 millisecond'),
           attempt_count=c.attempt_count+1,updated_at=clock_timestamp()
         FROM candidate q WHERE c.id=q.id
         RETURNING c.*
       )
       SELECT c.id,c.watch_id,c.observation_id,c.watch_version,c.attempt_count,
         w.user_id,w.trip_id,w.owner_membership_id
       FROM claimed c JOIN price_watches w ON w.id=c.watch_id`,
      [owner, leaseMs, PRICE_ALERT_MAX_ATTEMPTS],
    );
    return result.rows[0];
  }

  async retry(
    owner: string,
    candidate: ClaimedPriceAlert,
    errorCode: string,
  ): Promise<'RETRY' | 'FAILED' | 'STALE'> {
    const delay = priceAlertRetryDelay(candidate.attempt_count);
    const retry = delay !== undefined && candidate.attempt_count < PRICE_ALERT_MAX_ATTEMPTS;
    const result = await this.database.query(
      `UPDATE price_alert_candidates SET status=$4::varchar,
         next_attempt_at=clock_timestamp()+($5::int*interval '1 millisecond'),
         completed_at=CASE WHEN $4::varchar='FAILED' THEN clock_timestamp() ELSE NULL END,
         claim_owner=NULL,claim_until=NULL,last_error=$6,updated_at=clock_timestamp()
       WHERE id=$1 AND status='PROCESSING' AND claim_owner=$2 AND attempt_count=$3`,
      [
        candidate.id,
        owner,
        candidate.attempt_count,
        retry ? 'PENDING' : 'FAILED',
        delay ?? 0,
        errorCode,
      ],
    );
    if (!result.rowCount) return 'STALE';
    return retry ? 'RETRY' : 'FAILED';
  }

  async applyAccessLoss(
    owner: string,
    candidate: ClaimedPriceAlert,
    reason: 'TRIP_ARCHIVED' | 'ACCESS_REVOKED',
  ): Promise<'SUPPRESSED' | 'STALE'> {
    return this.database.withTransaction(async (client) => {
      const row = (
        await client.query<{ query_group_id: string; status: string; version: number }>(
          `SELECT w.query_group_id,w.status,w.version FROM price_alert_candidates c
           JOIN price_watches w ON w.id=c.watch_id
           WHERE c.id=$1 AND c.status='PROCESSING' AND c.claim_owner=$2
             AND c.attempt_count=$3
           FOR UPDATE OF c,w`,
          [candidate.id, owner, candidate.attempt_count],
        )
      ).rows[0];
      if (!row) return 'STALE';
      if (['ACTIVE', 'PAUSED'].includes(row.status) && row.version >= 2_147_483_647)
        throw new Error('PRICE_WATCH_VERSION_EXHAUSTED');
      await client.query(
        `UPDATE price_alert_candidates SET status='SUPPRESSED',completed_at=clock_timestamp(),
           claim_owner=NULL,claim_until=NULL,last_error=$2,updated_at=clock_timestamp()
         WHERE id=$1`,
        [candidate.id, reason],
      );
      if (reason === 'TRIP_ARCHIVED') {
        await client.query(
          `UPDATE price_watches SET status='PAUSED',status_reason='TRIP_ARCHIVED',
             version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 AND status='ACTIVE' AND version<2147483647`,
          [candidate.watch_id],
        );
      } else {
        await client.query(
          `UPDATE price_watches SET status='STOPPED',status_reason='ACCESS_REVOKED',
             alert_armed=false,version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 AND status IN ('ACTIVE','PAUSED') AND version<2147483647`,
          [candidate.watch_id],
        );
      }
      await reconcileQueryGroup(client, row.query_group_id);
      return 'SUPPRESSED';
    });
  }

  async completeNotification(
    owner: string,
    candidate: ClaimedPriceAlert,
    membershipId: string,
  ): Promise<AlertCompletion> {
    return this.database.withTransaction(async (client) => {
      const row = (
        await client.query<CandidateDetailRow>(
          `SELECT c.id,c.watch_id,c.observation_id,c.watch_version,c.attempt_count,
             c.status,c.claim_owner,w.user_id,w.trip_id,w.owner_membership_id,
             w.query_group_id,w.status AS watch_status,w.version,
             w.threshold_price::text,w.expires_at,w.last_alert_price::text,
             w.last_alert_at,w.alert_armed,o.query_group_id AS observation_query_group_id,
             o.price::text,o.observed_at
           FROM price_alert_candidates c
           JOIN price_watches w ON w.id=c.watch_id
           JOIN price_observations o ON o.id=c.observation_id
           WHERE c.id=$1 FOR UPDATE OF c,w`,
          [candidate.id],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== 'PROCESSING' ||
        row.claim_owner !== owner ||
        row.attempt_count !== candidate.attempt_count
      )
        return 'STALE';

      const finish = async (
        status: 'SUPPRESSED' | 'SUPERSEDED' | 'FAILED',
        error: string,
      ): Promise<AlertCompletion> => {
        await client.query(
          `UPDATE price_alert_candidates SET status=$2,completed_at=clock_timestamp(),
             claim_owner=NULL,claim_until=NULL,last_error=$3,updated_at=clock_timestamp()
           WHERE id=$1`,
          [candidate.id, status, error],
        );
        return status;
      };

      const now = (await client.query<{ value: Date }>('SELECT clock_timestamp() AS value'))
        .rows[0]!.value;
      if (
        row.watch_version !== row.version ||
        row.watch_status !== 'ACTIVE' ||
        row.owner_membership_id !== membershipId ||
        date(row.expires_at).getTime() <= date(now).getTime() ||
        row.query_group_id !== row.observation_query_group_id
      )
        return finish('SUPPRESSED', 'WATCH_CHANGED');
      if (row.version >= 2_147_483_647) return finish('FAILED', 'WATCH_VERSION_EXHAUSTED');

      const latest = (
        await client.query<{ id: string }>(
          `SELECT id FROM price_observations WHERE query_group_id=$1
           ORDER BY observed_at DESC,id DESC LIMIT 1`,
          [row.query_group_id],
        )
      ).rows[0];
      if (!latest || latest.id !== row.observation_id)
        return finish('SUPERSEDED', 'NEWER_OBSERVATION');

      const decision = evaluatePriceAlert({
        price: String(row.price),
        thresholdPrice: String(row.threshold_price),
        lastAlertPrice: row.last_alert_price === null ? null : String(row.last_alert_price),
        lastAlertAt: row.last_alert_at,
        alertArmed: row.alert_armed,
        evaluatedAt: date(now),
      });
      if (!decision.reason) return finish('SUPPRESSED', 'RULE_NO_LONGER_MATCHES');

      const updated = await client.query(
        `UPDATE price_watches SET last_alert_price=$2,last_alert_at=clock_timestamp(),
           alert_armed=false,version=version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND version=$3 AND status='ACTIVE'`,
        [row.watch_id, row.price, row.version],
      );
      if (!updated.rowCount) return finish('SUPPRESSED', 'WATCH_CHANGED');
      const dedupeKey = `price-alert:${row.watch_id}:${row.observation_id}`;
      await client.query(
        `INSERT INTO notifications(
           user_id,trip_id,type,title,body,source_id,status,dedupe_key
         ) VALUES($1,$2,'PRICE_ALERT','Giá vé đã giảm',$3,$4,'AVAILABLE',$5)
         ON CONFLICT(dedupe_key) DO NOTHING`,
        [
          row.user_id,
          row.trip_id,
          `Giá tham khảo ${String(row.price)} VND đang thấp hơn ngưỡng bạn đặt.`,
          row.watch_id,
          dedupeKey,
        ],
      );
      await client.query(
        `UPDATE price_alert_candidates SET status='NOTIFIED',completed_at=clock_timestamp(),
           claim_owner=NULL,claim_until=NULL,last_error=NULL,updated_at=clock_timestamp()
         WHERE id=$1`,
        [candidate.id],
      );
      return 'NOTIFIED';
    });
  }
}
