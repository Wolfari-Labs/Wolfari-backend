import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { recordPriceAlertCandidates } from './price-alert.repository';
import type { PoolClient, QueryResultRow } from 'pg';
import type { NormalizedPriceQuery } from './price-watch.domain';
import {
  PRICE_WATCH_MAX_PROVIDER_CALLS,
  nextPriceWatchSlot,
  priceWatchSlot,
  retryDelay,
  type ClaimedPriceAttempt,
  type ValidPriceObservation,
} from './price-watch-worker.domain';

type AttemptRow = QueryResultRow & {
  id: string;
  query_group_id: string;
  scheduled_slot: Date | string;
  attempt_count: number;
  canonical_key: string;
  params: NormalizedPriceQuery | string;
};

export interface ScheduleResult {
  attemptsCreated: number;
  watchesExpired: number;
  groupsDeactivated: number;
}

export type FailureResult = 'RETRY' | 'FAILED' | 'STALE';

function iso(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error('Invalid database timestamp');
  return result.toISOString();
}

function query(value: NormalizedPriceQuery | string): NormalizedPriceQuery {
  return typeof value === 'string' ? (JSON.parse(value) as NormalizedPriceQuery) : value;
}

function claim(row: AttemptRow): ClaimedPriceAttempt {
  return {
    id: row.id,
    query_group_id: row.query_group_id,
    scheduled_slot: iso(row.scheduled_slot),
    attempt_count: row.attempt_count,
    canonical_key: row.canonical_key,
    query: query(row.params),
  };
}

async function updateGroupResult(
  client: PoolClient,
  input: {
    queryGroupId: string;
    scheduledSlot: string;
    errorCode: string | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE price_query_groups q SET last_checked_at=clock_timestamp(),last_error=$3,
       updated_at=clock_timestamp()
     WHERE q.id=$1 AND NOT EXISTS(
       SELECT 1 FROM price_query_attempts newer
       WHERE newer.query_group_id=q.id AND newer.scheduled_slot>$2::timestamptz
         AND newer.status IN ('SUCCEEDED','NO_RESULT','FAILED')
     )`,
    [input.queryGroupId, input.scheduledSlot, input.errorCode],
  );
}

@Injectable()
export class PriceWatchWorkerRepository {
  constructor(private readonly database: DatabaseProvider) {}

  async scheduleDue(at: Date, batchSize: number): Promise<ScheduleResult> {
    const slot = priceWatchSlot(at);
    const nextSlot = nextPriceWatchSlot(slot);
    return this.database.withTransaction(async (client) => {
      const expired = await client.query<{ query_group_id: string }>(
        `UPDATE price_watches SET status='EXPIRED',status_reason='DEPARTED',
           alert_armed=false,version=version+1,updated_at=clock_timestamp()
         WHERE status IN ('ACTIVE','PAUSED') AND expires_at<=$1 AND version<2147483647
         RETURNING query_group_id`,
        [at.toISOString()],
      );
      const deactivated = await client.query(
        `UPDATE price_query_groups q SET active=false,next_check_at=NULL,updated_at=clock_timestamp()
         WHERE q.active=true AND NOT EXISTS(
           SELECT 1 FROM price_watches w
           WHERE w.query_group_id=q.id AND w.status='ACTIVE' AND w.expires_at>$1
         )`,
        [at.toISOString()],
      );
      const due = await client.query<{ id: string }>(
        `SELECT q.id FROM price_query_groups q
         WHERE q.active=true AND q.next_check_at<=$1
           AND EXISTS(
             SELECT 1 FROM price_watches w
             WHERE w.query_group_id=q.id AND w.status='ACTIVE' AND w.expires_at>$1
           )
         ORDER BY q.next_check_at,q.id
         FOR UPDATE OF q SKIP LOCKED LIMIT $2`,
        [at.toISOString(), batchSize],
      );
      let attemptsCreated = 0;
      for (const group of due.rows) {
        const inserted = await client.query(
          `INSERT INTO price_query_attempts(query_group_id,scheduled_slot,next_attempt_at)
           VALUES($1,$2,$3) ON CONFLICT(query_group_id,scheduled_slot) DO NOTHING`,
          [group.id, slot.toISOString(), at.toISOString()],
        );
        attemptsCreated += inserted.rowCount ?? 0;
        await client.query(
          `UPDATE price_query_groups SET next_check_at=$2,updated_at=clock_timestamp()
           WHERE id=$1`,
          [group.id, nextSlot.toISOString()],
        );
      }
      return {
        attemptsCreated,
        watchesExpired: expired.rowCount ?? 0,
        groupsDeactivated: deactivated.rowCount ?? 0,
      };
    });
  }

  async failExhaustedLeases(batchSize: number): Promise<number> {
    return this.database.withTransaction(async (client) => {
      const rows = await client.query<{
        id: string;
        query_group_id: string;
        scheduled_slot: Date | string;
      }>(
        `SELECT id,query_group_id,scheduled_slot FROM price_query_attempts
         WHERE status='RUNNING' AND claim_until<=clock_timestamp()
           AND attempt_count>=$1
         ORDER BY scheduled_slot,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [PRICE_WATCH_MAX_PROVIDER_CALLS, batchSize],
      );
      for (const row of rows.rows) {
        await client.query(
          `UPDATE price_query_attempts SET status='FAILED',completed_at=clock_timestamp(),
             error_code='LEASE_EXHAUSTED',claim_owner=NULL,claim_until=NULL,
             next_attempt_at=clock_timestamp()
           WHERE id=$1 AND status='RUNNING' AND attempt_count>=$2`,
          [row.id, PRICE_WATCH_MAX_PROVIDER_CALLS],
        );
        await updateGroupResult(client, {
          queryGroupId: row.query_group_id,
          scheduledSlot: iso(row.scheduled_slot),
          errorCode: 'LEASE_EXHAUSTED',
        });
      }
      return rows.rowCount ?? 0;
    });
  }

  async claimNext(owner: string, leaseMs: number): Promise<ClaimedPriceAttempt | undefined> {
    const result = await this.database.query<AttemptRow>(
      `WITH candidate AS (
         SELECT a.id FROM price_query_attempts a
         WHERE a.attempt_count<$3 AND (
           (a.status='PENDING' AND a.next_attempt_at<=clock_timestamp()) OR
           (a.status='RUNNING' AND a.claim_until<=clock_timestamp())
         )
         ORDER BY a.next_attempt_at,a.scheduled_slot,a.id
         FOR UPDATE SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE price_query_attempts a SET status='RUNNING',claim_owner=$1,
           claim_until=clock_timestamp()+($2::int*interval '1 millisecond'),
           attempt_count=a.attempt_count+1,started_at=COALESCE(a.started_at,clock_timestamp())
         FROM candidate c WHERE a.id=c.id
         RETURNING a.id,a.query_group_id,a.scheduled_slot,a.attempt_count
       )
       SELECT c.id,c.query_group_id,c.scheduled_slot,c.attempt_count,q.canonical_key,q.params
       FROM claimed c JOIN price_query_groups q ON q.id=c.query_group_id`,
      [owner, leaseMs, PRICE_WATCH_MAX_PROVIDER_CALLS],
    );
    return result.rows[0] ? claim(result.rows[0]) : undefined;
  }

  async completeSuccess(
    owner: string,
    attempt: ClaimedPriceAttempt,
    observation: ValidPriceObservation,
  ): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE price_query_attempts SET status='SUCCEEDED',completed_at=clock_timestamp(),
           error_code=NULL,claim_owner=NULL,claim_until=NULL,next_attempt_at=clock_timestamp()
         WHERE id=$1 AND status='RUNNING' AND claim_owner=$2 AND attempt_count=$3
         RETURNING id`,
        [attempt.id, owner, attempt.attempt_count],
      );
      if (!updated.rowCount) return false;
      await client.query('SELECT id FROM price_query_groups WHERE id=$1 FOR UPDATE', [
        attempt.query_group_id,
      ]);
      const saved = (
        await client.query<{ id: string; observed_at: Date }>(
        `INSERT INTO price_observations(
           query_group_id,query_attempt_id,price,currency,provider,fare_metadata,observed_at,fetched_at
         ) VALUES($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp(),clock_timestamp())
         RETURNING id,observed_at`,
        [
          attempt.query_group_id,
          attempt.id,
          observation.price,
          observation.currency,
          observation.provider,
          JSON.stringify(observation.fare_metadata),
        ],
        )
      ).rows[0]!;
      await recordPriceAlertCandidates(client, {
        id: saved.id,
        queryGroupId: attempt.query_group_id,
        price: observation.price,
        observedAt: saved.observed_at,
      });
      await updateGroupResult(client, {
        queryGroupId: attempt.query_group_id,
        scheduledSlot: attempt.scheduled_slot,
        errorCode: null,
      });
      return true;
    });
  }

  async completeNoResult(owner: string, attempt: ClaimedPriceAttempt): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE price_query_attempts SET status='NO_RESULT',completed_at=clock_timestamp(),
           error_code=NULL,claim_owner=NULL,claim_until=NULL,next_attempt_at=clock_timestamp()
         WHERE id=$1 AND status='RUNNING' AND claim_owner=$2 AND attempt_count=$3
         RETURNING id`,
        [attempt.id, owner, attempt.attempt_count],
      );
      if (!updated.rowCount) return false;
      await updateGroupResult(client, {
        queryGroupId: attempt.query_group_id,
        scheduledSlot: attempt.scheduled_slot,
        errorCode: null,
      });
      return true;
    });
  }

  async completeFailure(
    owner: string,
    attempt: ClaimedPriceAttempt,
    errorCode: string,
    transient: boolean,
  ): Promise<FailureResult> {
    const delay = transient ? retryDelay(attempt.attempt_count) : undefined;
    const retry = delay !== undefined && attempt.attempt_count < PRICE_WATCH_MAX_PROVIDER_CALLS;
    return this.database.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE price_query_attempts SET status=$4::varchar,
           completed_at=CASE WHEN $4::varchar='FAILED' THEN clock_timestamp() ELSE NULL END,
           error_code=$5,claim_owner=NULL,claim_until=NULL,
           next_attempt_at=clock_timestamp()+($6::int*interval '1 millisecond')
         WHERE id=$1 AND status='RUNNING' AND claim_owner=$2 AND attempt_count=$3
         RETURNING id`,
        [
          attempt.id,
          owner,
          attempt.attempt_count,
          retry ? 'PENDING' : 'FAILED',
          errorCode,
          delay ?? 0,
        ],
      );
      if (!updated.rowCount) return 'STALE';
      await updateGroupResult(client, {
        queryGroupId: attempt.query_group_id,
        scheduledSlot: attempt.scheduled_slot,
        errorCode,
      });
      return retry ? 'RETRY' : 'FAILED';
    });
  }
}
