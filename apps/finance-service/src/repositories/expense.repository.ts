import { DatabaseProvider } from '@wolfari/database';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  assertCanCreateExpense,
  ExpenseRuleError,
  planExpenseMutation,
  planExpenseSettlement,
  type ExpenseState,
} from '../domain/expense-management';
import {
  assertCanSpend,
  InsufficientAvailableBalanceError,
  type RefundForBalance,
} from '../domain/fund-balance';
import { calculateBalanceAfterEntry } from '../domain/ledger-balance';
import { calculateLedgerReversal, LedgerReversalNotAllowedError } from '../domain/ledger-reversal';
import type {
  ExpenseAction,
  ExpenseConfirm,
  ExpensePage,
  ExpensePatch,
  ExpenseReasonAction,
  ExpenseWrite,
} from '../inputs/expense.input';
import { expenseCursor } from '../inputs/expense.input';
import { FinanceReadError } from '../finance.errors';
import { expenseResponse, type ExpenseRow } from '../projections/expense-response';
import { ReceiptRepository } from '../receipts/receipt.repository';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type ExpenseWriteCommand =
  | { scope: 'CREATE_EXPENSE'; fundId: string; body: ExpenseWrite }
  | {
      scope: 'UPDATE_EXPENSE' | 'DELETE_EXPENSE' | 'SUBMIT_EXPENSE' | 'WITHDRAW_EXPENSE';
      fundId: string;
      expenseId: string;
      body: ExpensePatch | ExpenseAction;
    }
  | {
      scope: 'CONFIRM_EXPENSE' | 'REJECT_EXPENSE' | 'REVERSE_EXPENSE';
      fundId: string;
      expenseId: string;
      body: ExpenseConfirm | ExpenseReasonAction;
    };
export const isExpenseWrite = (input: FundWrite): input is FundWrite & ExpenseWriteCommand =>
  [
    'CREATE_EXPENSE',
    'UPDATE_EXPENSE',
    'DELETE_EXPENSE',
    'SUBMIT_EXPENSE',
    'WITHDRAW_EXPENSE',
    'CONFIRM_EXPENSE',
    'REJECT_EXPENSE',
    'REVERSE_EXPENSE',
  ].includes(input.scope);

const columns = `id,fund_id,title,description,amount::text,category,receipt_object_key,status,
created_by_user_id,submitted_at,paid_at,payment_method,paid_by_user_id,confirmed_at,
confirmed_by_user_id,rejected_reason,created_at,updated_at,version`;
const listColumns = `e.id,e.fund_id,e.title,e.description,e.amount::text,e.category,
e.receipt_object_key,e.status,e.created_by_user_id,e.submitted_at,e.paid_at,e.payment_method,
e.paid_by_user_id,e.confirmed_at,e.confirmed_by_user_id,e.rejected_reason,e.created_at,
e.updated_at,e.version`;
type Client = Pick<DatabaseProvider, 'query'>;

function state(row: ExpenseRow): ExpenseState {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    status: row.status as ExpenseState['status'],
    version: row.version,
    title: row.title,
    description: row.description,
    amount: BigInt(row.amount),
    category: row.category,
    receiptObjectKey: row.receipt_object_key,
    paidAt: row.paid_at === null ? null : new Date(row.paid_at),
    paymentMethod: row.payment_method,
  };
}

async function lockedRefunds(client: Client, fundId: string): Promise<RefundForBalance[]> {
  return (
    await client.query<{ amount: string; status: RefundForBalance['status'] }>(
      'SELECT amount::text,status FROM fund_refunds WHERE fund_id=$1 ORDER BY id FOR UPDATE',
      [fundId],
    )
  ).rows.map((refund) => ({ amount: BigInt(refund.amount), status: refund.status }));
}

async function nextLedgerSequence(client: Client, fundId: string) {
  const last = (
    await client.query<{ sequence: string }>(
      'SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM fund_transactions WHERE fund_id=$1',
      [fundId],
    )
  ).rows[0]!;
  const sequence = BigInt(last.sequence) + 1n;
  if (sequence > 9223372036854775807n) throw new FinanceReadError('STATE_CONFLICT');
  return sequence;
}

@Injectable()
export class ExpenseRepository {
  constructor(
    @Inject(DatabaseProvider)
    private readonly db: Pick<DatabaseProvider, 'query'>,
    @Optional()
    @Inject(ReceiptRepository)
    private readonly files?: Pick<ReceiptRepository, 'bind'>,
  ) {}

  async list(page: ExpensePage): Promise<{
    financeVersion: number;
    items: ExpenseRow[];
    nextCursor?: string;
  }> {
    const instant = `to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const result = await this.db.query<{
      finance_version: number;
      items: { row: ExpenseRow; at: string; id: string }[];
    }>(
      `WITH page AS (
        SELECT e.id,e.created_at FROM fund_expenses e
        WHERE e.fund_id=$1 AND e.deleted_at IS NULL
          AND ($2::text IS NULL OR e.status=$2)
          AND ($3::timestamptz IS NULL OR (e.created_at,e.id)<($3::timestamptz,$4::uuid))
        ORDER BY e.created_at DESC,e.id DESC LIMIT $5
      ), public_rows AS (
        SELECT ${listColumns} FROM fund_expenses e JOIN page p ON p.id=e.id
      )
      SELECT f.finance_version,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'row',to_jsonb(e),'at',${instant},'id',p.id) ORDER BY p.created_at DESC,p.id DESC)
        FROM page p JOIN public_rows e ON e.id=p.id),'[]'::jsonb) AS items
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
      nextCursor: row.items.length > page.limit && last ? expenseCursor(page, last) : undefined,
    };
  }

  async execute(
    client: Client,
    input: FundWrite & ExpenseWriteCommand,
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
      financeVersion: fund.finance_version,
      fundStatus: fund.status,
      holderUserId: fund.holder_user_id,
    };
    let row: ExpenseRow;
    let fromVersion: number | null = null;
    let balanceAfter: bigint | undefined;
    let auditDetails: Record<string, unknown> = {};
    if (input.scope === 'CREATE_EXPENSE') {
      assertCanCreateExpense(input.body, context);
      row = (
        await client.query<ExpenseRow>(
          `INSERT INTO fund_expenses
          (fund_id,title,description,amount,category,receipt_object_key,paid_at,payment_method,created_by_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,
          [
            input.fundId,
            input.body.title,
            input.body.description,
            input.body.amount.toString(),
            input.body.category,
            input.body.receiptObjectKey,
            input.body.paidAt,
            input.body.paymentMethod,
            input.actor,
          ],
        )
      ).rows[0]!;
      if (input.body.receiptObjectKey) {
        if (!this.files) throw new Error('Missing receipt repository');
        await this.files.bind(client, input.fundId, input.body.receiptObjectKey, input.actor, {
          expenseId: row.id,
        });
      }
    } else {
      row = (
        await client.query<ExpenseRow>(
          `SELECT ${columns} FROM fund_expenses
          WHERE id=$1 AND fund_id=$2 AND deleted_at IS NULL FOR UPDATE`,
          [input.expenseId, input.fundId],
        )
      ).rows[0]!;
      if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      fromVersion = row.version;
      const settlement = ['CONFIRM_EXPENSE', 'REJECT_EXPENSE', 'REVERSE_EXPENSE'].includes(
        input.scope,
      );
      const plan = settlement
        ? planExpenseSettlement(
            input.scope as 'CONFIRM_EXPENSE' | 'REJECT_EXPENSE' | 'REVERSE_EXPENSE',
            input.body as ExpenseConfirm | ExpenseReasonAction,
            state(row),
            context,
          )
        : planExpenseMutation(
            input.scope as
              'UPDATE_EXPENSE' | 'DELETE_EXPENSE' | 'SUBMIT_EXPENSE' | 'WITHDRAW_EXPENSE',
            input.body as ExpensePatch | ExpenseAction,
            state(row),
            context,
          );
      if ('changed' in plan && !plan.changed) {
        return {
          version: 1,
          tripId: input.tripId,
          expense: expenseResponse(row, fund.finance_version),
        };
      }
      if (row.version === 2147483647) throw new FinanceReadError('STATE_CONFLICT');
      if (input.scope === 'UPDATE_EXPENSE') {
        const patch = input.body as ExpensePatch;
        if (
          patch.receiptObjectKey !== undefined &&
          patch.receiptObjectKey !== row.receipt_object_key &&
          patch.receiptObjectKey !== null
        ) {
          if (!this.files) throw new Error('Missing receipt repository');
          await this.files.bind(client, input.fundId, patch.receiptObjectKey, input.actor, {
            expenseId: row.id,
          });
        }
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET
              title=COALESCE($2,title),
              description=CASE WHEN $3 THEN $4 ELSE description END,
              amount=COALESCE($5,amount),
              category=CASE WHEN $6 THEN $7 ELSE category END,
              receipt_object_key=CASE WHEN $8 THEN $9 ELSE receipt_object_key END,
              paid_at=CASE WHEN $10 THEN $11 ELSE paid_at END,
              payment_method=CASE WHEN $12 THEN $13 ELSE payment_method END,
              version=version+1,updated_at=clock_timestamp()
            WHERE id=$1 RETURNING ${columns}`,
            [
              row.id,
              patch.title ?? null,
              patch.description !== undefined,
              patch.description ?? null,
              patch.amount?.toString() ?? null,
              patch.category !== undefined,
              patch.category ?? null,
              patch.receiptObjectKey !== undefined,
              patch.receiptObjectKey ?? null,
              patch.paidAt !== undefined,
              patch.paidAt ?? null,
              patch.paymentMethod !== undefined,
              patch.paymentMethod ?? null,
            ],
          )
        ).rows[0]!;
      } else if (input.scope === 'DELETE_EXPENSE') {
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET deleted_at=clock_timestamp(),version=version+1,
            updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
      } else if (input.scope === 'SUBMIT_EXPENSE') {
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET status='SUBMITTED',submitted_at=clock_timestamp(),
            version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
      } else if (input.scope === 'WITHDRAW_EXPENSE') {
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET status='DRAFT',submitted_at=NULL,
            version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
      } else if (input.scope === 'CONFIRM_EXPENSE') {
        const body = input.body as ExpenseConfirm;
        try {
          const refunds = await lockedRefunds(client, input.fundId);
          assertCanSpend(BigInt(fund.current_balance), refunds, BigInt(row.amount));
          balanceAfter = calculateBalanceAfterEntry(
            BigInt(fund.current_balance),
            'OUT',
            BigInt(row.amount),
          );
        } catch (error) {
          if (error instanceof InsufficientAvailableBalanceError || error instanceof RangeError)
            throw new FinanceReadError('STATE_CONFLICT');
          throw error;
        }
        const sequence = await nextLedgerSequence(client, input.fundId);
        const ledger = (
          await client.query<{ id: string }>(
            `INSERT INTO fund_transactions
            (fund_id,sequence,direction,transaction_type,amount,balance_after,expense_id,actor_user_id,business_key)
            VALUES($1,$2,'OUT','EXPENSE',$3,$4,$5,$6,$7) RETURNING id`,
            [
              input.fundId,
              sequence.toString(),
              row.amount,
              balanceAfter.toString(),
              row.id,
              input.actor,
              `expense:${row.id}`,
            ],
          )
        ).rows[0]!;
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET status='CONFIRMED',paid_at=$2,payment_method=$3,
            paid_by_user_id=$4,confirmed_by_user_id=$4,confirmed_at=clock_timestamp(),
            version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id, body.paidAt, body.paymentMethod, input.actor],
          )
        ).rows[0]!;
        auditDetails = { ledger_id: ledger.id };
      } else if (input.scope === 'REJECT_EXPENSE') {
        const body = input.body as ExpenseReasonAction;
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET status='REJECTED',rejected_reason=$2,
            version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id, body.reason],
          )
        ).rows[0]!;
        auditDetails = { reason: body.reason };
      } else {
        const body = input.body as ExpenseReasonAction;
        const originals = (
          await client.query<{
            id: string;
            direction: string;
            transaction_type: string;
            amount: string;
            reversal_of_id: string | null;
          }>(
            `SELECT id,direction,transaction_type,amount::text,reversal_of_id
             FROM fund_transactions WHERE fund_id=$1 AND expense_id=$2 ORDER BY id FOR UPDATE`,
            [input.fundId, row.id],
          )
        ).rows;
        if (originals.length !== 1) throw new FinanceReadError('SERVICE_UNAVAILABLE');
        const original = originals[0]!;
        const direction = original.direction.trimEnd();
        if (
          direction !== 'OUT' ||
          original.transaction_type !== 'EXPENSE' ||
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
              `reversal:expense:${row.id}`,
            ],
          )
        ).rows[0]!;
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET status='REVERSED',version=version+1,
            updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
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
      VALUES($1,$2,$3,'Expense',$4,$5,$6,$7,$8::jsonb)`,
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
    return {
      version: 1,
      tripId: input.tripId,
      expense: expenseResponse(row, financeVersion),
    };
  }
}

export function mapExpenseRuleError(error: unknown) {
  return error instanceof ExpenseRuleError ? new FinanceReadError(error.code) : undefined;
}
