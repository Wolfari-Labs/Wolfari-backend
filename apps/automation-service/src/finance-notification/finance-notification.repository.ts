import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  FINANCE_NOTIFICATION_CONSUMER,
  InvalidFinanceNotificationEvent,
  recipientUuid,
  type FinanceNotificationEvent,
} from './finance-notification.event';

type Query = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<R>>;
type InboxResult = { event_hash?: string };

@Injectable()
export class FinanceNotificationRepository {
  constructor(
    @Inject(DatabaseProvider) private readonly database: Pick<DatabaseProvider, 'pool'>,
  ) {}

  private async withClient<T>(work: (query: Query) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    const deadline = Date.now() + 5000;
    let failed = false;
    try {
      const query: Query = <R extends QueryResultRow>(text: string, values: unknown[] = []) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('FINANCE_NOTIFICATION_DB_TIMEOUT');
        const queryConfig = { text, values, query_timeout: remaining };
        return client.query<R>(queryConfig);
      };
      return await work(query);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Destroy uncertain connections: this also rolls back an unfinished transaction.
      client.release(failed);
    }
  }

  private async existing(query: Query, event: FinanceNotificationEvent): Promise<boolean> {
    const result = await query<{ result: InboxResult }>(
      'SELECT result FROM inbox_events WHERE consumer_name=$1 AND event_id=$2',
      [FINANCE_NOTIFICATION_CONSUMER, event.eventId],
    );
    if (!result.rowCount) return false;
    if (result.rows[0]?.result?.event_hash !== event.fingerprint)
      throw new InvalidFinanceNotificationEvent();
    return true;
  }

  isProcessed(event: FinanceNotificationEvent): Promise<boolean> {
    return this.withClient((query) => this.existing(query, event));
  }

  complete(
    event: FinanceNotificationEvent,
    users: string[],
    sourceRevision?: number,
  ): Promise<'APPLIED' | 'DUPLICATE'> {
    const recipients = users.map(recipientUuid).sort();
    const closure = 'closureId' in event;
    const review = 'contributionId' in event;
    const sourceId = closure ? event.closureId : review ? event.contributionId : event.requestId;
    if (
      new Set(recipients).size !== recipients.length ||
      (!closure && recipients.length > (review ? 1 : event.contributionCount)) ||
      (review &&
        (recipients.length > 0 || sourceRevision !== undefined) &&
        (!Number.isInteger(sourceRevision) || sourceRevision! < 1 || sourceRevision! > 2147483647))
    )
      throw new Error('FINANCE_NOTIFICATION_RECIPIENTS_INVALID');
    return this.withClient(async (query) => {
      await query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const claimed = await query(
        `INSERT INTO inbox_events(consumer_name,event_id,event_type,aggregate_id,aggregate_version,result)
         VALUES($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT(consumer_name,event_id) DO NOTHING RETURNING event_id`,
        [
          FINANCE_NOTIFICATION_CONSUMER,
          event.eventId,
          closure ? 'ClosureRequested' : review ? 'ContributionUpdated' : 'ContributionRequested',
          event.fundId,
          event.version,
          JSON.stringify({
            event_hash: event.fingerprint,
          }),
        ],
      );
      if (!claimed.rowCount) {
        if (!(await this.existing(query, event)))
          throw new Error('FINANCE_NOTIFICATION_INBOX_CONFLICT');
        await query('COMMIT');
        return 'DUPLICATE';
      }
      if (closure) {
        // Serialize distinct events for each source/user, in deterministic order.
        // READ COMMITTED then observes the preceding worker's committed notification.
        for (const user of recipients)
          await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `finance-closure-notice:${sourceId}:${user}`,
          ]);
      }
      const inserted = recipients.length
        ? await query(
            `INSERT INTO notifications(user_id,trip_id,type,title,body,source_id,event_id,status,dedupe_key,created_at)
         SELECT recipient,$2::uuid,$7::varchar,$3::varchar,$4::text,$5::varchar,$6::uuid,'AVAILABLE',
           $8::text || $10::text || ':' || recipient::text,statement_timestamp()
         FROM unnest($1::uuid[]) AS recipient
         WHERE NOT $9::boolean OR NOT EXISTS (
           SELECT 1 FROM notifications n WHERE n.user_id=recipient
             AND n.type='CLOSURE_REQUESTED' AND n.source_id=$5::varchar
             AND n.created_at > statement_timestamp()-interval '24 hours'
         ) ${review ? 'ON CONFLICT(dedupe_key) DO NOTHING' : ''} RETURNING id`,
            [
              recipients,
              event.tripId,
              closure
                ? 'Yêu cầu xác nhận đóng quỹ'
                : review
                  ? 'Báo chuyển chờ xác nhận'
                  : 'Yêu cầu đóng góp',
              closure
                ? 'Có yêu cầu xác nhận đóng quỹ. Mở chuyến đi để xem thông tin hiện tại.'
                : review
                  ? 'Có báo chuyển cần kiểm tra. Mở chuyến đi để xem thông tin hiện tại.'
                  : 'Một yêu cầu đóng góp đã được tạo. Mở chuyến đi để xem thông tin hiện tại.',
              sourceId,
              event.eventId,
              closure
                ? 'CLOSURE_REQUESTED'
                : review
                  ? 'CONTRIBUTION_REVIEW'
                  : 'CONTRIBUTION_REQUESTED',
              closure ? 'finance-closure:' : review ? 'finance-review:' : 'finance-request:',
              closure,
              review ? `${sourceId}:${sourceRevision}` : event.eventId,
            ],
          )
        : undefined;
      const count = inserted?.rowCount ?? 0;
      await query(
        'UPDATE inbox_events SET result=$3::jsonb WHERE consumer_name=$1 AND event_id=$2',
        [
          FINANCE_NOTIFICATION_CONSUMER,
          event.eventId,
          JSON.stringify({
            event_hash: event.fingerprint,
            ...(closure
              ? { closure_id: sourceId, cooldown_suppressed: recipients.length - count }
              : review
                ? {
                    contribution_id: sourceId,
                    source_revision: sourceRevision,
                    duplicate_suppressed: recipients.length - count,
                  }
                : { request_id: sourceId }),
            outcome: count ? 'CREATED' : 'SUPPRESSED',
            count,
          }),
        ],
      );
      await query('COMMIT');
      return 'APPLIED';
    });
  }
}
