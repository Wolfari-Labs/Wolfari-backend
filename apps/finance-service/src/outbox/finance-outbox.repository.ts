import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseProvider } from '@wolfari/database';
import { EVENT_TOPOLOGY } from '@wolfari/contracts/events';
import type { QueryResult, QueryResultRow } from 'pg';
import { UUID } from '../finance.errors';
import { storedFinanceEvent, type FinanceOutboxRow } from './finance-outbox.event';

export type { FinanceOutboxRow } from './finance-outbox.event';
export interface ClaimedFinanceEvent extends FinanceOutboxRow {
  claim_owner: string;
  claim_until: Date | string;
  attempt_count: number;
}
export type FinanceOutboxFailure = 'PUBLISH_FAILED' | 'INVALID_EVENT';
type BoundedClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
};
const columns = `event_id,event_type,schema_version,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,producer,aggregate_type,
  aggregate_id,aggregate_version,correlation_id,causation_id,operation_id,trip_id,
  actor_user_id,system_actor,payload`;
const claimColumns = `${columns},claim_owner,claim_until,attempt_count`;
const fence = `event_id=$1 AND status='PENDING' AND claim_owner=$2
  AND attempt_count=$3 AND claim_until>clock_timestamp()`;

@Injectable()
export class FinanceOutboxRepository {
  constructor(
    @Inject(DatabaseProvider)
    private readonly database: Pick<DatabaseProvider, 'pool'>,
  ) {}

  private async withClient<T>(work: (client: BoundedClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    let failed = false;
    try {
      return await work({
        query: <Row extends QueryResultRow>(text: string, values: unknown[] = []) => {
          // pg supports per-query response timeouts; its QueryConfig typings omit this option.
          const queryConfig = { text, values, query_timeout: 5000 };
          return client.query<Row>(queryConfig);
        },
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A client timeout does not cancel the server query. Destroy the socket, including
      // any open replay transaction, rather than returning uncertain work to the pool.
      client.release(failed);
    }
  }

  private query<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.withClient((client) => client.query<Row>(text, values));
  }

  private transaction<T>(work: (client: BoundedClient) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    });
  }

  async claimNext(): Promise<ClaimedFinanceEvent | undefined> {
    const result = await this.query<ClaimedFinanceEvent>(
      `WITH candidate AS (
        SELECT event_id FROM outbox_events
        WHERE status='PENDING' AND next_attempt_at<=clock_timestamp()
          AND (claim_until IS NULL OR claim_until<=clock_timestamp())
        ORDER BY next_attempt_at,created_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE outbox_events o SET claim_owner=$1,
        claim_until=clock_timestamp()+interval '30 seconds',
        attempt_count=CASE WHEN o.attempt_count<2147483647 THEN o.attempt_count+1 ELSE o.attempt_count END
      WHERE o.event_id IN (SELECT event_id FROM candidate)
      RETURNING ${claimColumns}`,
      [randomUUID()],
    );
    return result.rows[0];
  }

  async complete(claim: ClaimedFinanceEvent): Promise<boolean> {
    const result = await this.query(
      `UPDATE outbox_events SET status='PUBLISHED',published_at=clock_timestamp(),
        claim_owner=NULL,claim_until=NULL,last_error=NULL WHERE ${fence}`,
      [claim.event_id, claim.claim_owner, claim.attempt_count],
    );
    return result.rowCount === 1;
  }

  async fail(
    claim: ClaimedFinanceEvent,
    reason: FinanceOutboxFailure,
    permanent = false,
  ): Promise<boolean> {
    if (
      !['PUBLISH_FAILED', 'INVALID_EVENT'].includes(reason) ||
      permanent !== (reason === 'INVALID_EVENT')
    )
      throw new Error('INVALID_FINANCE_OUTBOX_FAILURE');
    const delays = EVENT_TOPOLOGY.retry_delays_ms;
    const delay =
      delays[Math.min(Math.max(claim.attempt_count - 1, 0), delays.length - 1)] ?? 900000;
    const result = await this.query(
      `UPDATE outbox_events SET status=$4,
        next_attempt_at=clock_timestamp()+($5::integer*interval '1 millisecond'),
        claim_owner=NULL,claim_until=NULL,last_error=$6 WHERE ${fence}`,
      [
        claim.event_id,
        claim.claim_owner,
        claim.attempt_count,
        permanent ? 'FAILED' : 'PENDING',
        delay,
        reason,
      ],
    );
    return result.rowCount === 1;
  }

  async replayFailed(eventId: string, reason: string): Promise<boolean> {
    if (
      typeof eventId !== 'string' ||
      typeof reason !== 'string' ||
      !UUID.test(eventId) ||
      !/^[A-Za-z0-9._-]{3,80}$/.test(reason)
    )
      throw new Error('INVALID_FINANCE_OUTBOX_REPLAY');
    return this.transaction(async (client) => {
      const row = (
        await client.query<FinanceOutboxRow>(
          `SELECT ${columns} FROM outbox_events WHERE event_id=$1 AND status='FAILED'
          AND (claim_until IS NULL OR claim_until<=clock_timestamp()) FOR UPDATE`,
          [eventId.toLowerCase()],
        )
      ).rows[0];
      if (!row) return false;
      storedFinanceEvent(row);
      const result = await client.query(
        `UPDATE outbox_events SET status='PENDING',attempt_count=0,
          next_attempt_at=clock_timestamp(),published_at=NULL,claim_owner=NULL,claim_until=NULL,
          last_error=$2 WHERE event_id=$1 AND status='FAILED'`,
        [eventId.toLowerCase(), 'OPERATOR_REPLAY:' + reason],
      );
      return result.rowCount === 1;
    });
  }

  async diagnostics(): Promise<{ pending: number; failed: number }> {
    const row = (
      await this.query<{ pending: string; failed: string }>(
        `SELECT count(*) FILTER(WHERE status='PENDING')::text AS pending,
        count(*) FILTER(WHERE status='FAILED')::text AS failed FROM outbox_events`,
      )
    ).rows[0];
    if (
      !row ||
      ![row.pending, row.failed].every(
        (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
      )
    )
      throw new Error('INVALID_FINANCE_OUTBOX_COUNTS');
    return { pending: Number(row.pending), failed: Number(row.failed) };
  }
}
