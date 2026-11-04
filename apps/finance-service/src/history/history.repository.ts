import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { FinanceReadError } from '../finance.errors';
import { HISTORY_ACTIONS, type HistoryPage, type HistoryRow } from './history.domain';

const reason = `COALESCE(reason, CASE WHEN jsonb_typeof(details->'reason')='string' THEN details->>'reason' END)`;

@Injectable()
export class FinanceHistoryRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'pool'>) {}

  async list(page: HistoryPage, deadline: number): Promise<HistoryRow[]> {
    if (Date.now() >= deadline) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const client = await this.db.pool.connect();
    let broken = false;
    try {
      const remaining = Math.floor(deadline - Date.now());
      if (remaining <= 0) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining)]);
      // Extract only the existing business reason. Raw details/before/after, bank
      // data, provider payloads, operation keys and private files never cross SQL.
      const queryConfig = {
        text: `SELECT id,fund_id,actor_user_id,system_actor,action,entity_type,entity_id,
          from_version,to_version,correlation_id,
          CASE WHEN octet_length(${reason})<=8000 THEN ${reason} END AS reason,
          COALESCE(octet_length(${reason})>8000,false) AS reason_oversized,
          to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
          FROM finance_audit_logs WHERE fund_id=$1 AND action=ANY($5::text[])
          AND ($2::timestamptz IS NULL OR (occurred_at,id)<($2::timestamptz,$3::uuid))
          ORDER BY occurred_at DESC,id DESC LIMIT $4`,
        values: [
          page.fundId,
          page.before?.at ?? null,
          page.before?.id ?? null,
          page.limit + 1,
          HISTORY_ACTIONS,
        ],
        query_timeout: Math.max(1, Math.floor(deadline - Date.now())),
      };
      const result = await client.query<HistoryRow>(queryConfig);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
