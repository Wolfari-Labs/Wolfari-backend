import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  parseCreateExpense,
  parseExpenseAction,
  parseExpensePage,
  parseUpdateExpense,
} from '../inputs/expense.input';
import { expenseResponse } from '../projections/expense-response';
import { ExpenseRepository, type ExpenseWriteCommand } from '../repositories/expense.repository';
import { ReceiptService } from '../receipts/receipt.service';
import { FundCommandService } from './fund-command.service';
import { FundQueryService } from './fund-query.service';

function nullableChange(
  value: FinanceV1.NullableStringChange | undefined,
): { present: false } | { present: true; value: string | null } {
  if (value === undefined) return { present: false };
  const hasValue = value.value !== undefined;
  const hasClear = value.clear !== undefined;
  if (hasValue === hasClear || (hasClear && value.clear !== true))
    throw new FinanceReadError('VALIDATION_FAILED');
  return { present: true, value: hasClear ? null : value.value! };
}

@Injectable()
export class ExpenseService {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly rows: ExpenseRepository,
    private readonly auth: FundQueryService,
    private readonly commands: FundCommandService,
    private readonly files: ReceiptService,
  ) {}
  async list(
    request: FinanceV1.ListExpensesRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListExpensesResponse> {
    const actor = readUuid(request.actor_user_id);
    const page = parseExpensePage(request);
    await this.auth.authorizeFundRead(page.fundId, actor, correlation, deadline);
    const result = await this.rows.list(page);
    return {
      items: result.items.map((row) => expenseResponse(row, result.financeVersion)),
      next_cursor: result.nextCursor,
    };
  }
  async create(request: FinanceV1.CreateExpenseRequest, correlation: string, deadline: number) {
    const operationId = readUuid(request.operation_id);
    const actor = readUuid(request.actor_user_id);
    const fundId = readUuid(request.fund_id);
    const body = parseCreateExpense({
      title: request.title,
      description: request.description,
      amount: request.amount,
      category: request.category,
      receipt_object_key: request.receipt_object_key,
      paid_at: request.paid_at,
      payment_method: request.payment_method,
      expected_finance_version: request.expected_finance_version,
    });
    return this.run(
      { scope: 'CREATE_EXPENSE', fundId, body },
      operationId,
      actor,
      correlation,
      deadline,
    );
  }
  async manage(
    scope: Exclude<ExpenseWriteCommand['scope'], 'CREATE_EXPENSE'>,
    request: FinanceV1.UpdateExpenseRequest & FinanceV1.DeleteExpenseRequest,
    correlation: string,
    deadline: number,
  ) {
    const operationId = readUuid(request.operation_id);
    const actor = readUuid(request.actor_user_id);
    const expenseId = readUuid(request.expense_id);
    const found = (
      await this.db.query<{ fund_id: string }>(
        'SELECT fund_id FROM fund_expenses WHERE id=$1 AND deleted_at IS NULL',
        [expenseId],
      )
    ).rows[0];
    if (!found) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const description = nullableChange(request.description);
    const category = nullableChange(request.category);
    const receipt = nullableChange(request.receipt_object_key);
    const paidAt = nullableChange(request.paid_at);
    const paymentMethod = nullableChange(request.payment_method);
    const body =
      scope === 'UPDATE_EXPENSE'
        ? parseUpdateExpense({
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(description.present ? { description: description.value } : {}),
            ...(request.amount === undefined ? {} : { amount: request.amount }),
            ...(category.present ? { category: category.value } : {}),
            ...(receipt.present ? { receipt_object_key: receipt.value } : {}),
            ...(paidAt.present ? { paid_at: paidAt.value } : {}),
            ...(paymentMethod.present ? { payment_method: paymentMethod.value } : {}),
            expected_version: request.expected_version,
            expected_finance_version: request.expected_finance_version,
          })
        : parseExpenseAction({
            expected_version: request.expected_version,
            expected_finance_version: request.expected_finance_version,
          });
    return this.run(
      { scope, fundId: found.fund_id, expenseId, body },
      operationId,
      actor,
      correlation,
      deadline,
    );
  }
  private async run(
    mutation: ExpenseWriteCommand,
    operationId: string,
    actor: string,
    correlation: string,
    deadline: number,
  ) {
    const fund = (
      await this.db.query<{ trip_id: string }>('SELECT trip_id FROM funds WHERE id=$1', [
        mutation.fundId,
      ])
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const attachment =
      mutation.scope === 'CREATE_EXPENSE'
        ? (mutation.body.receiptObjectKey ?? undefined)
        : mutation.scope === 'UPDATE_EXPENSE'
          ? (mutation.body as ReturnType<typeof parseUpdateExpense>).receiptObjectKey
          : undefined;
    return this.commands.run(
      { ...mutation, operationId, actor, tripId: fund.trip_id },
      correlation,
      deadline,
      attachment
        ? async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
            try {
              await this.files.prepareAttachment(
                mutation.fundId,
                attachment,
                actor,
                controller.signal,
                undefined,
                mutation.scope === 'UPDATE_EXPENSE' ? mutation.expenseId : undefined,
              );
            } finally {
              clearTimeout(timer);
            }
          }
        : undefined,
    );
  }
}
