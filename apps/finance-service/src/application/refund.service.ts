import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  parseCreateRefund,
  parseRefundAction,
  parseRefundPage,
  parseRefundReasonAction,
} from '../inputs/refund.input';
import { refundResponse } from '../projections/refund-response';
import { RefundRepository, type RefundWriteCommand } from '../repositories/refund.repository';
import { FundCommandService } from './fund-command.service';
import { FundQueryService } from './fund-query.service';

type ManageRequest =
  | FinanceV1.ReportRefundPaidRequest
  | FinanceV1.ConfirmRefundReceivedRequest
  | FinanceV1.ConfirmRefundNonreceiptRequest
  | FinanceV1.CancelRefundRequest
  | FinanceV1.RequestRefundReversalRequest
  | FinanceV1.ConsentRefundReversalRequest
  | FinanceV1.ReverseRefundRequest;

@Injectable()
export class RefundService {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly rows: RefundRepository,
    private readonly auth: FundQueryService,
    private readonly commands: FundCommandService,
  ) {}
  async list(request: FinanceV1.ListRefundsRequest, correlation: string, deadline: number) {
    const actor = readUuid(request.actor_user_id);
    const page = parseRefundPage(request);
    await this.auth.authorizeFundRead(page.fundId, actor, correlation, deadline);
    const result = await this.rows.list(page);
    return {
      items: result.items.map((row) => refundResponse(row, result.financeVersion)),
      next_cursor: result.nextCursor,
    };
  }
  async create(request: FinanceV1.CreateRefundRequest, correlation: string, deadline: number) {
    const mutation: RefundWriteCommand = {
      scope: 'CREATE_REFUND',
      fundId: readUuid(request.fund_id),
      body: parseCreateRefund({
        member_user_id: request.member_user_id,
        amount: request.amount,
        reason: request.reason,
        expected_finance_version: request.expected_finance_version,
      }),
    };
    return this.run(
      mutation,
      readUuid(request.operation_id),
      readUuid(request.actor_user_id),
      correlation,
      deadline,
    );
  }
  async manage(
    scope: Exclude<RefundWriteCommand['scope'], 'CREATE_REFUND'>,
    request: ManageRequest,
    correlation: string,
    deadline: number,
  ) {
    const refundId = readUuid(request.refund_id);
    const found = (
      await this.db.query<{ fund_id: string }>('SELECT fund_id FROM fund_refunds WHERE id=$1', [
        refundId,
      ])
    ).rows[0];
    if (!found) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const reason = [
      'CONFIRM_REFUND_NONRECEIPT',
      'CANCEL_REFUND',
      'REQUEST_REFUND_REVERSAL',
      'REVERSE_REFUND',
    ].includes(scope);
    const body = reason
      ? parseRefundReasonAction({
          reason: (request as { reason?: string }).reason,
          expected_version: request.expected_version,
          expected_finance_version: request.expected_finance_version,
        })
      : parseRefundAction({
          expected_version: request.expected_version,
          expected_finance_version: request.expected_finance_version,
        });
    return this.run(
      { scope, fundId: found.fund_id, refundId, body } as RefundWriteCommand,
      readUuid(request.operation_id),
      readUuid(request.actor_user_id),
      correlation,
      deadline,
    );
  }
  private async run(
    mutation: RefundWriteCommand,
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
    return this.commands.run(
      { ...mutation, operationId, actor, tripId: fund.trip_id },
      correlation,
      deadline,
    );
  }
}
