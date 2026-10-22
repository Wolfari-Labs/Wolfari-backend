import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { createHash, randomUUID } from 'node:crypto';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  assertClosureAction,
  assertCreateClosure,
  ClosureRuleError,
} from '../domain/closure-management';
import type {
  CancelClosureInput,
  ClosurePage,
  ConfirmClosureInput,
  CreateClosureInput,
} from '../inputs/closure.input';
import { closureCursor } from '../inputs/closure.input';
import { FinanceReadError } from '../finance.errors';
import {
  closureResponse,
  type ClosureRow,
  type ConfirmationRow,
} from '../projections/closure-response';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type ClosureWriteCommand =
  | { scope: 'CREATE_CLOSURE'; fundId: string; body: CreateClosureInput }
  | {
      scope: 'CONFIRM_CLOSURE';
      fundId: string;
      closureId: string;
      body: ConfirmClosureInput;
    }
  | {
      scope: 'CANCEL_CLOSURE';
      fundId: string;
      closureId: string;
      body: CancelClosureInput;
    }
  | {
      scope: 'REMIND_CLOSURE';
      fundId: string;
      closureId: string;
      body: Record<string, never>;
    };
export const isClosureWrite = (input: FundWrite): input is FundWrite & ClosureWriteCommand =>
  ['CREATE_CLOSURE', 'CONFIRM_CLOSURE', 'CANCEL_CLOSURE', 'REMIND_CLOSURE'].includes(input.scope);

type Client = Pick<DatabaseProvider, 'query'>;
type FundRow = {
  id: string;
  trip_id: string;
  holder_user_id: string;
  currency: string;
  budget_amount: string | null;
  current_balance: string;
  status: string;
  finance_version: number;
};
const closureColumns = `id,fund_id,requested_by_user_id,status,snapshot_finance_version,
snapshot_schema_version,snapshot_json,snapshot_hash,requested_at,cancelled_at,cancelled_reason,closed_at`;
const MAX_INT32 = 2147483647;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function canonicalClosureSnapshot(value: unknown) {
  return JSON.stringify(canonical(value));
}
const hashSnapshot = (value: unknown) =>
  createHash('sha256').update(canonicalClosureSnapshot(value)).digest('hex');
const mapRule = (error: unknown) => {
  if (error instanceof ClosureRuleError) return new FinanceReadError(error.code);
  return error;
};

@Injectable()
export class ClosureRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  private async confirmations(client: Client, closureId: string) {
    return (
      await client.query<ConfirmationRow>(
        'SELECT user_id,confirmed_at FROM closure_confirmations WHERE closure_id=$1 ORDER BY user_id',
        [closureId],
      )
    ).rows;
  }
  async get(id: string, client: Client = this.db): Promise<FinanceV1.ClosureView | undefined> {
    const result = await client.query<ClosureRow & { finance_version: number }>(
      `SELECT ${closureColumns.replaceAll(/\b(id|fund_id|requested_by_user_id|status|snapshot_finance_version|snapshot_schema_version|snapshot_json|snapshot_hash|requested_at|cancelled_at|cancelled_reason|closed_at)\b/g, 'c.$1')},f.finance_version
       FROM finance_closures c JOIN funds f ON f.id=c.fund_id WHERE c.id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return closureResponse(row, await this.confirmations(client, id), row.finance_version);
  }
  async scope(id: string) {
    return (
      await this.db.query<{ fund_id: string; trip_id: string }>(
        'SELECT c.fund_id,f.trip_id FROM finance_closures c JOIN funds f ON f.id=c.fund_id WHERE c.id=$1',
        [id],
      )
    ).rows[0];
  }
  async list(page: ClosurePage): Promise<{
    items: FinanceV1.ClosureView[];
    nextCursor?: string;
  }> {
    const instant = `to_char(c.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const result = await this.db.query<{
      finance_version: number;
      items: Array<{ row: ClosureRow; confirmations: ConfirmationRow[]; at: string; id: string }>;
    }>(
      `WITH page AS (
        SELECT c.id,c.requested_at FROM finance_closures c WHERE c.fund_id=$1
        AND ($2::timestamptz IS NULL OR (c.requested_at,c.id)<($2::timestamptz,$3::uuid))
        ORDER BY c.requested_at DESC,c.id DESC LIMIT $4
      )
      SELECT f.finance_version,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'row',to_jsonb(c),'confirmations',COALESCE((SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.user_id)
          FROM closure_confirmations cc WHERE cc.closure_id=c.id),'[]'::jsonb),
        'at',${instant},'id',c.id) ORDER BY p.requested_at DESC,p.id DESC)
        FROM page p JOIN finance_closures c ON c.id=p.id),'[]'::jsonb) AS items
      FROM funds f WHERE f.id=$1`,
      [page.fundId, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const resultRow = result.rows[0];
    if (!resultRow) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const items = resultRow.items.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((item) =>
        closureResponse(item.row, item.confirmations, resultRow.finance_version),
      ),
      nextCursor:
        resultRow.items.length > page.limit && last ? closureCursor(page, last) : undefined,
    };
  }

  private async snapshot(
    client: Client,
    fund: FundRow,
    userIds: readonly string[],
    version: number,
  ) {
    const one = async (sql: string) =>
      (await client.query<Record<string, unknown>>(sql, [fund.id])).rows;
    const requests = await one(
      `SELECT id,title,amount_per_member::text,due_at,status,created_by_user_id,created_at,closed_at,note,version
       FROM contribution_requests WHERE fund_id=$1 ORDER BY id`,
    );
    const contributions = await one(
      `SELECT id,request_id,member_user_id,amount::text,status,self_contribution,member_reported_at,
       confirmed_by_user_id,confirmed_at,waived_reason,cancelled_reason,waived_at,cancelled_at,reversed_at,created_at,updated_at,version
       FROM contributions WHERE fund_id=$1 ORDER BY id`,
    );
    const expenses = await one(
      `SELECT id,title,description,amount::text,status,created_by_user_id,submitted_at,confirmed_at,
       cancelled_at,cancelled_reason,category,paid_at,payment_method,paid_by_user_id,rejected_reason,
       created_at,updated_at,version FROM fund_expenses WHERE fund_id=$1 AND deleted_at IS NULL ORDER BY id`,
    );
    const notes = await one(
      `SELECT id,payer_user_id,amount::text,description,created_by_user_id,version,created_at,updated_at
       FROM financial_notes WHERE fund_id=$1 AND deleted_at IS NULL ORDER BY id`,
    );
    const refunds = await one(
      `SELECT id,member_user_id,amount::text,status,reason,holder_reported_at,confirmed_at,
       nonreceipt_confirmed_at,reversal_requested_at,reversal_consented_at,created_at,updated_at,version
       FROM fund_refunds WHERE fund_id=$1 ORDER BY id`,
    );
    const ledger = await one(
      `SELECT id,sequence::text,direction,transaction_type,amount::text,balance_after::text,
       contribution_id,expense_id,refund_id,reversal_of_id,actor_user_id,reason,created_at
       FROM fund_transactions WHERE fund_id=$1 ORDER BY sequence,id`,
    );
    return canonical({
      schema_version: 1,
      fund: {
        id: fund.id,
        trip_id: fund.trip_id,
        holder_user_id: fund.holder_user_id,
        currency: fund.currency.trimEnd(),
        budget_amount: fund.budget_amount,
        current_balance: fund.current_balance,
        finance_version: version,
      },
      required_user_ids: [...userIds].sort(),
      contribution_requests: requests,
      contributions,
      expenses,
      financial_notes: notes,
      refunds,
      ledger,
    });
  }

  private async blockers(client: Client, fundId: string) {
    const result = await client.query<{ ledger_total: string; blockers: number }>(
      `SELECT
       COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END) FROM fund_transactions WHERE fund_id=$1),0)::text AS ledger_total,
       (SELECT COUNT(*) FROM (
         SELECT 1 FROM contributions WHERE fund_id=$1 AND status IN ('PENDING','TRANSFER_REPORTED')
         UNION ALL SELECT 1 FROM fund_expenses WHERE fund_id=$1 AND deleted_at IS NULL AND status IN ('DRAFT','SUBMITTED')
         UNION ALL SELECT 1 FROM fund_refunds WHERE fund_id=$1 AND
           (status IN ('PENDING','HOLDER_REPORTED') OR (status='CONFIRMED' AND reversal_requested_at IS NOT NULL))
         UNION ALL SELECT 1 FROM payment_attempts p JOIN contributions c ON c.id=p.contribution_id
           WHERE c.fund_id=$1 AND (p.needs_reconciliation OR p.status IN ('CREATED','PENDING') OR
             (p.status='SUCCEEDED' AND (c.status NOT IN ('CONFIRMED','REVERSED') OR NOT EXISTS
               (SELECT 1 FROM fund_transactions t WHERE t.fund_id=$1 AND t.contribution_id=c.id AND t.transaction_type='CONTRIBUTION'))))
         UNION ALL SELECT 1 FROM payment_webhook_receipts w JOIN payment_attempts p ON p.id=w.payment_attempt_id
           JOIN contributions c ON c.id=p.contribution_id WHERE c.fund_id=$1 AND w.signature_valid
           AND w.processing_status IN ('RECEIVED','NEEDS_REVIEW')
       ) blocked) AS blockers`,
      [fundId],
    );
    return result.rows[0]!;
  }

  async execute(
    client: Client,
    input: FundWrite & ClosureWriteCommand,
    authority: FundSetupContext & { closureLockId?: string },
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<FundRow>(
        `SELECT id,trip_id,holder_user_id,currency,budget_amount::text,current_balance::text,status,finance_version
         FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE`,
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    if (fund.finance_version >= MAX_INT32) throw new FinanceReadError('STATE_CONFLICT');
    const base = {
      ...authority,
      holderUserId: fund.holder_user_id,
      fundStatus: fund.status,
      financeVersion: fund.finance_version,
    };
    let row: ClosureRow;
    let financeVersion = fund.finance_version;
    let effect: StoredResult['closureEffect'];
    let changed = true;

    try {
      if (input.scope === 'CREATE_CLOSURE') {
        assertCreateClosure(input.body.expectedFinanceVersion, base);
        const check = await this.blockers(client, fund.id);
        if (
          BigInt(fund.current_balance) !== 0n ||
          BigInt(check.ledger_total) !== 0n ||
          Number(check.blockers) > 0
        )
          throw new FinanceReadError('STATE_CONFLICT');
        financeVersion++;
        const users = [...authority.activeMemberUserIds].sort();
        if (!users.length) throw new FinanceReadError('STATE_CONFLICT');
        const snapshot = await this.snapshot(client, fund, users, financeVersion);
        const snapshotJson = canonicalClosureSnapshot(snapshot);
        const snapshotHash = hashSnapshot(snapshot);
        row = (
          await client.query<ClosureRow>(
            `INSERT INTO finance_closures(fund_id,requested_by_user_id,status,snapshot_finance_version,
             snapshot_schema_version,snapshot_json,snapshot_hash,requested_at)
             VALUES($1,$2,'PENDING_CONFIRMATIONS',$3,1,$4::jsonb,$5,clock_timestamp()) RETURNING ${closureColumns}`,
            [fund.id, input.actor, financeVersion, snapshotJson, snapshotHash],
          )
        ).rows[0]!;
        for (const userId of users)
          await client.query(
            'INSERT INTO closure_confirmations(closure_id,user_id,snapshot_hash) VALUES($1,$2,$3)',
            [row.id, userId, snapshotHash],
          );
        await client.query(
          "UPDATE funds SET status='CLOSING',finance_version=$2,updated_at=clock_timestamp() WHERE id=$1",
          [fund.id, financeVersion],
        );
        await this.event(client, 'ClosureRequested', input, correlation, row, financeVersion);
        effect = { set_closure_lock_id: row.id };
      } else {
        row = (
          await client.query<ClosureRow>(
            `SELECT ${closureColumns} FROM finance_closures WHERE id=$1 AND fund_id=$2 FOR UPDATE`,
            [input.closureId, fund.id],
          )
        ).rows[0]!;
        if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
        const confirmations = await client.query<ConfirmationRow>(
          'SELECT user_id,confirmed_at FROM closure_confirmations WHERE closure_id=$1 ORDER BY user_id FOR UPDATE',
          [row.id],
        );
        assertClosureAction(input.scope, {
          ...base,
          closureStatus: row.status,
          closureUserIds: new Set(confirmations.rows.map((item) => item.user_id)),
        });
        if (authority.closureLockId !== row.id) throw new FinanceReadError('STATE_CONFLICT');
        if (input.scope === 'CONFIRM_CLOSURE') {
          if (input.body.snapshotHash !== row.snapshot_hash)
            throw new FinanceReadError('STATE_CONFLICT');
          const mine = confirmations.rows.find((item) => item.user_id === input.actor)!;
          if (mine.confirmed_at !== null) changed = false;
          else {
            await client.query(
              'UPDATE closure_confirmations SET confirmed_at=clock_timestamp() WHERE closure_id=$1 AND user_id=$2',
              [row.id, input.actor],
            );
            financeVersion++;
            const final = confirmations.rows.every(
              (item) => item.user_id === input.actor || item.confirmed_at !== null,
            );
            if (final) {
              row = (
                await client.query<ClosureRow>(
                  `UPDATE finance_closures SET status='COMPLETED',closed_at=clock_timestamp()
                   WHERE id=$1 RETURNING ${closureColumns}`,
                  [row.id],
                )
              ).rows[0]!;
              await client.query(
                "UPDATE funds SET status='CLOSED',closed_at=clock_timestamp(),finance_version=$2,updated_at=clock_timestamp() WHERE id=$1",
                [fund.id, financeVersion],
              );
              await this.event(client, 'FinanceClosed', input, correlation, row, financeVersion);
              effect = { release_closure_lock_id: row.id };
            } else {
              await client.query(
                'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
                [fund.id, financeVersion],
              );
            }
          }
        } else if (input.scope === 'CANCEL_CLOSURE') {
          financeVersion++;
          row = (
            await client.query<ClosureRow>(
              `UPDATE finance_closures SET status='CANCELLED',cancelled_at=clock_timestamp(),cancelled_reason=$2
               WHERE id=$1 RETURNING ${closureColumns}`,
              [row.id, input.body.reason],
            )
          ).rows[0]!;
          await client.query(
            "UPDATE funds SET status='OPEN',finance_version=$2,updated_at=clock_timestamp() WHERE id=$1",
            [fund.id, financeVersion],
          );
          await this.event(client, 'ClosureCancelled', input, correlation, row, financeVersion);
          effect = { release_closure_lock_id: row.id };
        } else {
          await this.event(client, 'ClosureRequested', input, correlation, row, financeVersion);
        }
      }
    } catch (error) {
      throw mapRule(error);
    }
    if (changed)
      await client.query(
        `INSERT INTO finance_audit_logs
         (fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details)
         VALUES($1,$2,$3,'Closure',$4,$5,$6,$7,$8::jsonb)`,
        [
          fund.id,
          input.actor,
          input.scope,
          row.id,
          fund.finance_version,
          financeVersion,
          correlation,
          JSON.stringify({ operation_id: input.operationId, snapshot_hash: row.snapshot_hash }),
        ],
      );
    return {
      version: 1,
      tripId: input.tripId,
      closure: closureResponse(row, await this.confirmations(client, row.id), financeVersion),
      closureEffect: effect,
    };
  }

  private async event(
    client: Client,
    eventType: 'ClosureRequested' | 'ClosureCancelled' | 'FinanceClosed',
    input: FundWrite & ClosureWriteCommand,
    correlation: string,
    row: ClosureRow,
    financeVersion: number,
  ) {
    const payload = {
      fund_id: input.fundId,
      trip_id: input.tripId,
      closure_id: row.id,
      ...(eventType === 'ClosureRequested' ? { snapshot_hash: row.snapshot_hash } : {}),
      finance_version: financeVersion,
    };
    await client.query(
      `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,
       correlation_id,payload,aggregate_type,producer,operation_id,trip_id,actor_user_id)
       VALUES($1,$2,1,$3,$4,$5,$6::jsonb,'Fund','Finance',$7,$8,$9)`,
      [
        randomUUID(),
        eventType,
        input.fundId,
        financeVersion,
        correlation,
        JSON.stringify(payload),
        input.operationId,
        input.tripId,
        input.actor,
      ],
    );
  }
}
