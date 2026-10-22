import { DatabaseProvider } from '@wolfari/database';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { FundSetupContext } from '../domain/fund-setup';
import {
  assertCanCreateExpense,
  ExpenseRuleError,
  planExpenseMutation,
  type ExpenseState,
} from '../domain/expense-management';
import type {
  ExpenseAction,
  ExpensePage,
  ExpensePatch,
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
    };
export const isExpenseWrite = (input: FundWrite): input is FundWrite & ExpenseWriteCommand =>
  [
    'CREATE_EXPENSE',
    'UPDATE_EXPENSE',
    'DELETE_EXPENSE',
    'SUBMIT_EXPENSE',
    'WITHDRAW_EXPENSE',
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
      await client.query<{ status: string; finance_version: number }>(
        'SELECT status,finance_version FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE',
        [input.fundId, input.tripId],
      )
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const context = {
      ...authority,
      financeVersion: fund.finance_version,
      fundStatus: fund.status,
    };
    let row: ExpenseRow;
    let fromVersion: number | null = null;
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
      const plan = planExpenseMutation(input.scope, input.body, state(row), context);
      if (!plan.changed) {
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
      } else {
        row = (
          await client.query<ExpenseRow>(
            `UPDATE fund_expenses SET status='DRAFT',submitted_at=NULL,
            version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
            [row.id],
          )
        ).rows[0]!;
      }
    }
    const financeVersion = fund.finance_version + 1;
    await client.query(
      'UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',
      [input.fundId, financeVersion],
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
        JSON.stringify({ operation_id: input.operationId, finance_version: financeVersion }),
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
