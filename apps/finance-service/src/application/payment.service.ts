import { Injectable } from '@nestjs/common';
import { CommonV1, type FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  parseCreatePaymentAttemptInput,
  parseMomoWebhookInput,
  parsePaymentExceptionPage,
  parseReconcilePaymentAttemptInput,
  parseResolvePaymentExceptionInput,
  PaymentInputError,
} from '../inputs/payment.input';
import { MomoSandboxProvider } from '../providers/momo-sandbox.provider';
import { PaymentRepository } from '../repositories/payment.repository';
import { FundCommandService } from './fund-command.service';
import { FundQueryService } from './fund-query.service';
import { PaymentProcessor } from './payment-processor';
import { paymentAttemptResponse } from '../projections/payment-response';

@Injectable()
export class PaymentService {
  constructor(
    private readonly rows: PaymentRepository,
    private readonly queries: FundQueryService,
    private readonly commands: FundCommandService,
    private readonly provider: MomoSandboxProvider,
    private readonly processor: PaymentProcessor,
  ) {}
  private input<T>(work: () => T) {
    try {
      return work();
    } catch (error) {
      if (error instanceof PaymentInputError) throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
  async create(
    request: FinanceV1.CreatePaymentAttemptRequest,
    correlation: string,
    deadline: number,
  ) {
    if (!this.provider.ready()) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id),
      contributionId = readUuid(request.contribution_id);
    const body = this.input(() =>
      parseCreatePaymentAttemptInput({
        provider: request.provider,
        expected_version: request.expected_version,
        expected_finance_version: request.expected_finance_version,
      }),
    );
    const scope = await this.rows.contributionScope(contributionId);
    if (!scope) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.queries.authorizePaymentInstruction(scope.fund_id, actor, correlation, deadline);
    if (scope.member_user_id !== actor) throw new FinanceReadError('PERMISSION_DENIED');
    const result = await this.commands.run(
      {
        scope: 'CREATE_PAYMENT_ATTEMPT',
        operationId,
        actor,
        tripId: scope.trip_id,
        fundId: scope.fund_id,
        contributionId,
        body: { ...body, merchantId: this.provider.partnerCode() },
      },
      correlation,
      deadline,
    );
    this.processor.kick();
    return result;
  }
  async get(request: FinanceV1.GetPaymentAttemptRequest, correlation: string, deadline: number) {
    const actor = readUuid(request.actor_user_id),
      id = readUuid(request.payment_attempt_id);
    const row = await this.rows.attemptScope(id);
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.queries.authorizeFundRead(row.fund_id, actor, correlation, deadline);
    if (actor !== row.member_user_id && actor !== row.holder_user_id)
      throw new FinanceReadError('PERMISSION_DENIED');
    const attempt = await this.rows.attempt(id);
    if (!attempt) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return { payment_attempt: paymentAttemptResponse(attempt) };
  }
  async reconcile(
    request: FinanceV1.ReconcilePaymentAttemptRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ReconcilePaymentAttemptResponse> {
    if (!this.provider.ready()) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id),
      id = readUuid(request.payment_attempt_id);
    const body = this.input(() => parseReconcilePaymentAttemptInput({ reason: request.reason }));
    const row = await this.rows.attemptScope(id);
    if (!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.queries.authorizeFundRead(row.fund_id, actor, correlation, deadline);
    if (actor !== row.holder_user_id) throw new FinanceReadError('PERMISSION_DENIED');
    const result = await this.commands.run(
      {
        scope: 'RECONCILE_PAYMENT_ATTEMPT',
        operationId,
        actor,
        tripId: row.trip_id,
        fundId: row.fund_id,
        paymentAttemptId: id,
        body,
      },
      correlation,
      deadline,
    );
    this.processor.kick();
    return {
      operation:
        result.operation ??
        ({
          operation_id: operationId,
          trip_id: row.trip_id,
          state: CommonV1.OperationState.OPERATION_STATE_SUCCEEDED,
          outcome: { status: CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED, blocking_ids: [] },
        } as CommonV1.Operation),
    };
  }
  async webhook(request: FinanceV1.ReceiveMomoWebhookRequest) {
    if (!this.provider.ready()) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const input = this.input(() =>
      parseMomoWebhookInput({
        partner_code: request.partner_code,
        order_id: request.order_id,
        request_id: request.request_id,
        amount: request.amount,
        order_info: request.order_info,
        order_type: request.order_type,
        transaction_id: request.transaction_id,
        result_code: request.result_code,
        message: request.message,
        pay_type: request.pay_type,
        response_time: request.response_time,
        extra_data: request.extra_data,
        signature: request.signature,
      }),
    );
    await this.rows.receiveWebhook(
      input,
      this.provider.verifyIpn(input),
      this.provider.partnerCode(),
    );
    this.processor.kick();
    return {};
  }
  async listExceptions(
    request: FinanceV1.ListPaymentExceptionsRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListPaymentExceptionsResponse> {
    const actor = readUuid(request.actor_user_id),
      fundId = readUuid(request.fund_id);
    const fund = await this.rows.fundScope(fundId);
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const role = await this.queries.authorizeFundRead(fundId, actor, correlation, deadline);
    if (role !== CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER && actor !== fund.holder_user_id)
      throw new FinanceReadError('PERMISSION_DENIED');
    const page = this.input(() =>
      parsePaymentExceptionPage({ fundId, limit: request.limit, cursor: request.cursor }),
    );
    const result = await this.rows.listExceptions(page);
    return { items: result.items, next_cursor: result.nextCursor };
  }
  async resolve(
    request: FinanceV1.ResolvePaymentExceptionRequest,
    correlation: string,
    deadline: number,
  ) {
    const operationId = readUuid(request.operation_id),
      actor = readUuid(request.actor_user_id),
      id = readUuid(request.payment_exception_id);
    const parsed = this.input(() =>
      parseResolvePaymentExceptionInput({
        resolution: request.resolution,
        linked_attempt_id: request.linked_attempt_id,
        reason: request.reason,
        expected_finance_version: request.expected_finance_version,
      }),
    );
    const body = parsed.linkedAttemptId
      ? { ...parsed, linkedAttemptId: readUuid(parsed.linkedAttemptId) }
      : parsed;
    const scope = await this.rows.exceptionScope(id);
    if (!scope) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.queries.authorizeFundRead(scope.fund_id, actor, correlation, deadline);
    if (actor !== scope.holder_user_id) throw new FinanceReadError('PERMISSION_DENIED');
    const result = await this.commands.run(
      {
        scope: 'RESOLVE_PAYMENT_EXCEPTION',
        operationId,
        actor,
        tripId: scope.trip_id,
        fundId: scope.fund_id,
        paymentExceptionId: id,
        body,
      },
      correlation,
      deadline,
    );
    this.processor.kick();
    return result;
  }
}
