import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';
import { RPC_CATALOG, type FinanceV1 } from '@wolfari/contracts/grpc';
import { FundQueryService } from './application/fund-query.service';
import { FinanceReadError, UUID } from './finance.errors';
import { FundCommandService } from './application/fund-command.service';
import {
  FundCommandRepository,
  fundCommandScope,
  receiptView,
} from './repositories/fund-command.repository';
import { readUuid } from './finance.errors';

type DeadlineCall = { getDeadline(): Date | number };
@Controller()
export class FinanceGrpcController {
  constructor(
    private readonly queries: FundQueryService,
    private readonly config: ConfigService,
    private readonly commands: FundCommandService,
    private readonly receipts: FundCommandRepository,
  ) {}

  private async execute<T>(
    method: string,
    metadata: Metadata | undefined,
    call: DeadlineCall | undefined,
    work: (correlation: string, deadline: number) => Promise<T>,
  ): Promise<T> {
    const single = (name: string) => {
      const values = metadata?.get(name);
      return values?.length === 1 && typeof values[0] === 'string' ? values[0] : '';
    };
    const caller = single('x-caller-service');
    const provided = Buffer.from(single('x-service-secret'));
    const expected = Buffer.from(
      this.config.get<string>(
        caller === 'Trip' ? 'TRIP_FINANCE_SECRET' : 'GATEWAY_FINANCE_SECRET',
      ) ?? '',
    );
    const correlation = single('x-correlation-id');
    const entry = RPC_CATALOG.find(
      (rpc) =>
        rpc.package === 'wolfari.finance.v1' &&
        rpc.service === 'FinanceService' &&
        rpc.method === method,
    );
    if (
      !['ApiGateway', 'Trip'].includes(caller) ||
      !entry?.callers.includes(caller) ||
      expected.length < 32 ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected) ||
      !UUID.test(correlation)
    ) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Caller is not authorized',
      });
    }
    const deadline = Math.min(Date.now() + 1800, Number(call?.getDeadline() ?? Infinity) - 100);
    try {
      return await work(correlation.toLowerCase(), deadline);
    } catch (error) {
      const code = error instanceof FinanceReadError ? error.code : 'SERVICE_UNAVAILABLE';
      throw new RpcException({
        code: {
          VALIDATION_FAILED: status.INVALID_ARGUMENT,
          RESOURCE_NOT_FOUND: status.NOT_FOUND,
          PERMISSION_DENIED: status.PERMISSION_DENIED,
          SERVICE_UNAVAILABLE: status.UNAVAILABLE,
          STATE_CONFLICT: status.FAILED_PRECONDITION,
          VERSION_CONFLICT: status.ABORTED,
          IDEMPOTENCY_CONFLICT: status.ALREADY_EXISTS,
        }[code],
        message: JSON.stringify({ code, details: null }),
      });
    }
  }
  @GrpcMethod('FinanceService', 'EnableFund')
  enableFund(
    request: FinanceV1.EnableFundRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<FinanceV1.EnableFundResponse> {
    return this.execute('EnableFund', metadata, call, (correlation, deadline) =>
      this.commands.enable(request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'UpdateFundBudget')
  updateFundBudget(
    request: FinanceV1.UpdateFundBudgetRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('UpdateFundBudget', metadata, call, (correlation, deadline) =>
      this.commands.configure('UPDATE_FUND_BUDGET', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'CreatePaymentDestination')
  createPaymentDestination(
    request: FinanceV1.CreatePaymentDestinationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('CreatePaymentDestination', metadata, call, (correlation, deadline) =>
      this.commands.configure('CREATE_PAYMENT_DESTINATION', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'UpdatePaymentDestination')
  updatePaymentDestination(
    request: FinanceV1.UpdatePaymentDestinationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('UpdatePaymentDestination', metadata, call, (correlation, deadline) =>
      this.commands.configure('UPDATE_PAYMENT_DESTINATION', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'ConfirmPaymentDestination')
  confirmPaymentDestination(
    request: FinanceV1.ConfirmPaymentDestinationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<FinanceV1.ConfirmPaymentDestinationResponse> {
    return this.execute('ConfirmPaymentDestination', metadata, call, (correlation, deadline) =>
      this.commands.confirm(request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'GetOperationResult')
  getOperationResult(
    request: FinanceV1.GetOperationResultRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute(
      'GetOperationResult',
      metadata,
      call,
      async (): Promise<FinanceV1.GetOperationResultResponse> => {
        const row = await this.receipts.find(readUuid(request.operation_id));
        if (!row) return { not_found: {} };
        if (!fundCommandScope(row.command_scope)) throw new FinanceReadError('SERVICE_UNAVAILABLE');
        return { receipt: receiptView(row) };
      },
    );
  }
  @GrpcMethod('FinanceService', 'CancelOperationIfNotCommitted')
  cancelOperation(
    request: FinanceV1.CancelOperationIfNotCommittedRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<FinanceV1.CancelOperationIfNotCommittedResponse> {
    return this.execute('CancelOperationIfNotCommitted', metadata, call, async () => ({
      receipt: receiptView(await this.receipts.cancel(request)),
    }));
  }
  @GrpcMethod('FinanceService', 'GetFund')
  getFund(request: FinanceV1.GetFundRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('GetFund', metadata, call, (correlation, deadline) =>
      this.queries.getFund(request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'ListPaymentDestinations')
  listPaymentDestinations(
    request: FinanceV1.ListPaymentDestinationsRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ListPaymentDestinations', metadata, call, (correlation, deadline) =>
      this.queries.listPaymentDestinations(request, correlation, deadline),
    );
  }
}
