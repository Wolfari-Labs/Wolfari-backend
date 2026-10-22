import { DatabaseProvider } from '@wolfari/database';
import { Inject, Injectable } from '@nestjs/common';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  assertCanCreateRefund,
  planRefundAction,
  RefundRuleError,
  type RefundState,
} from '../domain/refund-management';
import {
  assertCanSpend,
  calculateFundBalance,
  InsufficientAvailableBalanceError,
  type RefundForBalance,
} from '../domain/fund-balance';
import { calculateBalanceAfterEntry } from '../domain/ledger-balance';
import { calculateLedgerReversal, LedgerReversalNotAllowedError } from '../domain/ledger-reversal';
import type {
  RefundAction,
  RefundCreate,
  RefundPage,
  RefundReasonAction,
} from '../inputs/refund.input';
import { refundCursor } from '../inputs/refund.input';
import { FinanceReadError } from '../finance.errors';
import { refundResponse, type RefundRow } from '../projections/refund-response';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type RefundWriteCommand =
  | { scope: 'CREATE_REFUND'; fundId: string; body: RefundCreate }
  | {
      scope:
        | 'REPORT_REFUND_PAID'
        | 'CONFIRM_REFUND_RECEIVED'
        | 'CONFIRM_REFUND_NONRECEIPT'
        | 'CANCEL_REFUND'
        | 'REQUEST_REFUND_REVERSAL'
        | 'CONSENT_REFUND_REVERSAL'
        | 'REVERSE_REFUND';
      fundId: string;
      refundId: string;
      body: RefundAction | RefundReasonAction;
    };
export const isRefundWrite = (input: FundWrite): input is FundWrite & RefundWriteCommand =>
  [
    'CREATE_REFUND',
    'REPORT_REFUND_PAID',
    'CONFIRM_REFUND_RECEIVED',
    'CONFIRM_REFUND_NONRECEIPT',
    'CANCEL_REFUND',
    'REQUEST_REFUND_REVERSAL',
    'CONSENT_REFUND_REVERSAL',
    'REVERSE_REFUND',
  ].includes(input.scope);

const columns = `id,fund_id,member_user_id,amount::text,status,reason,requested_by_user_id,
holder_reported_at,confirmed_by_user_id,confirmed_at,cancelled_at,created_at,updated_at,version,
nonreceipt_confirmed_at,reversal_consented_at,reversal_requested_at,reversal_reason,cancelled_reason`;
const listColumns = `r.id,r.fund_id,r.member_user_id,r.amount::text,r.status,r.reason,r.requested_by_user_id,
r.holder_reported_at,r.confirmed_by_user_id,r.confirmed_at,r.cancelled_at,r.created_at,r.updated_at,r.version,
r.nonreceipt_confirmed_at,r.reversal_consented_at,r.reversal_requested_at,r.reversal_reason,r.cancelled_reason`;
type Client = Pick<DatabaseProvider, 'query'>;

function state(row: RefundRow): RefundState {
  return {
    memberUserId: row.member_user_id,
    status: row.status as RefundState['status'],
    version: row.version,
    nonreceiptConfirmedAt:
      row.nonreceipt_confirmed_at === null ? null : new Date(row.nonreceipt_confirmed_at),
    reversalRequestedAt:
      row.reversal_requested_at === null ? null : new Date(row.reversal_requested_at),
    reversalConsentedAt:
      row.reversal_consented_at === null ? null : new Date(row.reversal_consented_at),
    reversalReason: row.reversal_reason,
  };
}
async function lockedRefunds(client: Client, fundId: string) {
  return (
    await client.query<{ id: string; amount: string; status: RefundForBalance['status'] }>(
      'SELECT id,amount::text,status FROM fund_refunds WHERE fund_id=$1 ORDER BY id FOR UPDATE',
      [fundId],
    )
  ).rows.map((row) => ({ id: row.id, amount: BigInt(row.amount), status: row.status }));
}
async function nextLedgerSequence(client: Client, fundId: string) {
  const sequence =
    BigInt(
      (
        await client.query<{ sequence: string }>(
          'SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM fund_transactions WHERE fund_id=$1',
          [fundId],
        )
      ).rows[0]!.sequence,
    ) + 1n;
  if (sequence > 9223372036854775807n) throw new FinanceReadError('STATE_CONFLICT');
  return sequence;
}

@Injectable()
export class RefundRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  async list(
    page: RefundPage,
  ): Promise<{ financeVersion: number; items: RefundRow[]; nextCursor?: string }> {
    const instant = `to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const result = await this.db.query<{
      finance_version: number;
      items: { row: RefundRow; at: string; id: string }[];
    }>(
      `WITH page AS (
        SELECT r.id,r.created_at FROM fund_refunds r
        WHERE r.fund_id=$1 AND ($2::text IS NULL OR r.status=$2)
          AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
        ORDER BY r.created_at DESC,r.id DESC LIMIT $5
      ), public_rows AS (
        SELECT ${listColumns} FROM fund_refunds r JOIN page p ON p.id=r.id
      )
      SELECT f.finance_version,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'row',to_jsonb(r),'at',${instant},'id',p.id) ORDER BY p.created_at DESC,p.id DESC)
        FROM page p JOIN public_rows r ON r.id=p.id),'[]'::jsonb) AS items
      FROM funds f WHERE f.id=$1`,
      [
        page.fundId,
        page.status ?? null,
        page.after?.at ?? null,
        page.after?.id ?? null,
        page.limit + 1,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const items = row.items.slice(0, page.limit);
    const last = items.at(-1);
    return {
      financeVersion: row.finance_version,
      items: items.map((item) => item.row),
      nextCursor: row.items.length > page.limit && last ? refundCursor(page, last) : undefined,
    };
  }

  async execute(
    client: Client,
    input: FundWrite & RefundWriteCommand,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<{
        status: string;
        finance_version: number;
        holder_user_id: string;
        current_balance: string;
      }>(
        `SELECT status,finance_version,holder_user_id,current_balance::text
        FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE`,
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const context = {
      ...authority,
      holderUserId: fund.holder_user_id,
      fundStatus: fund.status,
      financeVersion: fund.finance_version,
    };
    let row: RefundRow;
    let fromVersion: number | null = null;
    let balanceAfter: bigint | undefined;
    let auditDetails: Record<string, unknown> = {};
    if (input.scope === 'CREATE_REFUND') {
      assertCanCreateRefund(input.body, context);
      try {
        assertCanSpend(
          BigInt(fund.current_balance),
          await lockedRefunds(client, input.fundId),
          input.body.amount,
        );
      } catch (error) {
        if (error instanceof InsufficientAvailableBalanceError || error instanceof RangeError)
          throw new FinanceReadError('STATE_CONFLICT');
        throw error;
      }
      row = (
        await client.query<RefundRow>(
          `INSERT INTO fund_refunds(fund_id,member_user_id,amount,reason,requested_by_user_id)
         VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,
          [
            input.fundId,
            input.body.memberUserId,
            input.body.amount.toString(),
            input.body.reason,
            input.actor,
          ],
        )
      ).rows[0]!;
    } else {
      row = (
        await client.query<RefundRow>(
          `SELECT ${columns} FROM fund_refunds WHERE id=$1 AND fund_id=$2 FOR UPDATE`,
          [input.refundId, input.fundId],
        )
      ).rows[0]!;
      if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      fromVersion = row.version;
      planRefundAction(input.scope, input.body, state(row), context);
      if (input.scope === 'REPORT_REFUND_PAID') {
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET status='HOLDER_REPORTED',holder_reported_at=clock_timestamp(),
           nonreceipt_confirmed_at=NULL,version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
      } else if (input.scope === 'CONFIRM_REFUND_RECEIVED') {
        const refunds = await lockedRefunds(client, input.fundId);
        try {
          balanceAfter = calculateBalanceAfterEntry(
            BigInt(fund.current_balance),
            'OUT',
            BigInt(row.amount),
          );
          calculateFundBalance(
            balanceAfter,
            refunds.map((refund) =>
              refund.id === row.id
                ? { amount: refund.amount, status: 'CONFIRMED' as const }
                : refund,
            ),
          );
        } catch (error) {
          if (error instanceof RangeError) throw new FinanceReadError('STATE_CONFLICT');
          throw error;
        }
        const sequence = await nextLedgerSequence(client, input.fundId);
        const ledger = (
          await client.query<{ id: string }>(
            `INSERT INTO fund_transactions
           (fund_id,sequence,direction,transaction_type,amount,balance_after,refund_id,actor_user_id,business_key)
           VALUES($1,$2,'OUT','REFUND',$3,$4,$5,$6,$7) RETURNING id`,
            [
              input.fundId,
              sequence.toString(),
              row.amount,
              balanceAfter.toString(),
              row.id,
              input.actor,
              `refund:${row.id}`,
            ],
          )
        ).rows[0]!;
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET status='CONFIRMED',confirmed_by_user_id=$2,
           confirmed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 RETURNING ${columns}`,
            [row.id, input.actor],
          )
        ).rows[0]!;
        auditDetails = { ledger_id: ledger.id };
      } else if (input.scope === 'CONFIRM_REFUND_NONRECEIPT') {
        const body = input.body as RefundReasonAction;
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET nonreceipt_confirmed_at=clock_timestamp(),
           version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
        auditDetails = { reason: body.reason };
      } else if (input.scope === 'CANCEL_REFUND') {
        const body = input.body as RefundReasonAction;
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET status='CANCELLED',cancelled_at=clock_timestamp(),cancelled_reason=$2,
           version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id, body.reason],
          )
        ).rows[0]!;
        auditDetails = { reason: body.reason };
      } else if (input.scope === 'REQUEST_REFUND_REVERSAL') {
        const body = input.body as RefundReasonAction;
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET reversal_requested_at=clock_timestamp(),reversal_reason=$2,
           version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id, body.reason],
          )
        ).rows[0]!;
        auditDetails = { reason: body.reason };
      } else if (input.scope === 'CONSENT_REFUND_REVERSAL') {
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET reversal_consented_at=clock_timestamp(),
           version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
      } else {
        const body = input.body as RefundReasonAction;
        const originals = (
          await client.query<{
            id: string;
            direction: string;
            transaction_type: string;
            amount: string;
            reversal_of_id: string | null;
          }>(
            `SELECT id,direction,transaction_type,amount::text,reversal_of_id
            FROM fund_transactions WHERE fund_id=$1 AND refund_id=$2 ORDER BY id FOR UPDATE`,
            [input.fundId, row.id],
          )
        ).rows;
        if (originals.length !== 1) throw new FinanceReadError('SERVICE_UNAVAILABLE');
        const original = originals[0]!;
        const direction = original.direction.trimEnd();
        if (
          direction !== 'OUT' ||
          original.transaction_type !== 'REFUND' ||
          BigInt(original.amount) !== BigInt(row.amount) ||
          original.reversal_of_id !== null
        )
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
        const existing = await client.query(
          'SELECT id FROM fund_transactions WHERE reversal_of_id=$1 FOR UPDATE',
          [original.id],
        );
        try {
          const effect = calculateLedgerReversal(
            {
              id: original.id,
              direction,
              amount: BigInt(original.amount),
              reversalOfId: original.reversal_of_id,
            },
            {
              currentBalance: BigInt(fund.current_balance),
              refunds: await lockedRefunds(client, input.fundId),
              hasExistingReversal: Boolean(existing.rowCount),
            },
          );
          balanceAfter = effect.balanceAfter;
        } catch (error) {
          if (
            error instanceof LedgerReversalNotAllowedError ||
            error instanceof InsufficientAvailableBalanceError ||
            error instanceof RangeError
          )
            throw new FinanceReadError('STATE_CONFLICT');
          throw error;
        }
        const sequence = await nextLedgerSequence(client, input.fundId);
        const reversal = (
          await client.query<{ id: string }>(
            `INSERT INTO fund_transactions
           (fund_id,sequence,direction,transaction_type,amount,balance_after,reversal_of_id,actor_user_id,reason,business_key)
           VALUES($1,$2,'IN','REVERSAL',$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              input.fundId,
              sequence.toString(),
              row.amount,
              balanceAfter.toString(),
              original.id,
              input.actor,
              body.reason,
              `reversal:refund:${row.id}`,
            ],
          )
        ).rows[0]!;
        row = (
          await client.query<RefundRow>(
            `UPDATE fund_refunds SET status='REVERSED',version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
        auditDetails = {
          reason: body.reason,
          original_ledger_id: original.id,
          reversal_ledger_id: reversal.id,
        };
      }
    }
    const financeVersion = fund.finance_version + 1;
    if (balanceAfter === undefined)
      await client.query(
        'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
        [input.fundId, financeVersion],
      );
    else
      await client.query(
        `UPDATE funds SET current_balance=$2,finance_version=$3,
        updated_at=clock_timestamp() WHERE id=$1`,
        [input.fundId, balanceAfter.toString(), financeVersion],
      );
    await client.query(
      `INSERT INTO finance_audit_logs
       (fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details)
       VALUES($1,$2,$3,'Refund',$4,$5,$6,$7,$8::jsonb)`,
      [
        input.fundId,
        input.actor,
        input.scope,
        row.id,
        fromVersion,
        row.version,
        correlation,
        JSON.stringify({
          operation_id: input.operationId,
          finance_version: financeVersion,
          ...auditDetails,
        }),
      ],
    );
    return { version: 1, tripId: input.tripId, refund: refundResponse(row, financeVersion) };
  }
}

export function mapRefundRuleError(error: unknown) {
  return error instanceof RefundRuleError ? new FinanceReadError(error.code) : undefined;
}
