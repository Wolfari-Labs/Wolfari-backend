import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  FINANCE_NOTIFICATION_CONSUMER,
  InvalidFinanceNotificationEvent,
  recipientUuid,
  type ContributionNotificationEvent,
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

  private async existing(query: Query, event: ContributionNotificationEvent): Promise<boolean> {
    const result = await query<{ result: InboxResult }>(
      'SELECT result FROM inbox_events WHERE consumer_name=$1 AND event_id=$2',
      [FINANCE_NOTIFICATION_CONSUMER, event.eventId],
    );
    if (!result.rowCount) return false;
    if (result.rows[0]?.result?.event_hash !== event.fingerprint)
      throw new InvalidFinanceNotificationEvent();
    return true;
  }

  isProcessed(event: ContributionNotificationEvent): Promise<boolean> {
    return this.withClient((query) => this.existing(query, event));
  }

  complete(
    event: ContributionNotificationEvent,
    users: string[],
  ): Promise<'APPLIED' | 'DUPLICATE'> {
    const recipients = users.map(recipientUuid);
    if (
      new Set(recipients).size !== recipients.length ||
      recipients.length > event.contributionCount
    )
      throw new Error('FINANCE_NOTIFICATION_RECIPIENTS_INVALID');
    return this.withClient(async (query) => {
      await query('BEGIN');
      const claimed = await query(
        `INSERT INTO inbox_events(consumer_name,event_id,event_type,aggregate_id,aggregate_version,result)
         VALUES($1,$2,'ContributionRequested',$3,$4,$5::jsonb)
         ON CONFLICT(consumer_name,event_id) DO NOTHING RETURNING event_id`,
        [
          FINANCE_NOTIFICATION_CONSUMER,
          event.eventId,
          event.fundId,
          event.version,
          JSON.stringify({
            event_hash: event.fingerprint,
            request_id: event.requestId,
            outcome: recipients.length ? 'CREATED' : 'SUPPRESSED',
            count: recipients.length,
          }),
        ],
      );
      if (!claimed.rowCount) {
        if (!(await this.existing(query, event)))
          throw new Error('FINANCE_NOTIFICATION_INBOX_CONFLICT');
        await query('COMMIT');
        return 'DUPLICATE';
      }
      if (recipients.length)
        await query(
          `INSERT INTO notifications(user_id,trip_id,type,title,body,source_id,event_id,status,dedupe_key)
         SELECT recipient,$2,'CONTRIBUTION_REQUESTED',$3,$4,$5,$6::uuid,'AVAILABLE',
           'finance-request:' || $6::uuid::text || ':' || recipient::text
         FROM unnest($1::uuid[]) AS recipient`,
          [
            recipients,
            event.tripId,
            'Yêu cầu đóng góp',
            'Một yêu cầu đóng góp đã được tạo. Mở chuyến đi để xem thông tin hiện tại.',
            event.requestId,
            event.eventId,
          ],
        );
      await query('COMMIT');
      return 'APPLIED';
    });
  }
}
