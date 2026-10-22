import { PaymentInstructionService } from './application/payment-instruction.service';
import { ReceiptService } from './receipts/receipt.service';
import { ManualContributionService } from './application/manual-contribution.service';
import { Controller, Logger } from '@nestjs/common';
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
  lifecycleCommandScope,
  receiptView,
} from './repositories/fund-command.repository';
import { readUuid } from './finance.errors';
import { ContributionCommandService } from './application/contribution-command.service';
import { ContributionQueryService } from './application/contribution-query.service';
import { ContributionReversalService } from './application/contribution-reversal.service';
import { ExpenseService } from './application/expense.service';
import { FinancialNoteService } from './application/financial-note.service';
import { RefundService } from './application/refund.service';
import { ClosureService } from './application/closure.service';
import { PaymentService } from './application/payment.service';
import { LifecycleFinanceRepository } from './repositories/lifecycle-finance.repository';

type DeadlineCall = {
  getDeadline(): Date | number;
  cancelled?: boolean;
  once?(event: 'cancelled', listener: () => void): unknown;
  off?(event: 'cancelled', listener: () => void): unknown;
};
@Controller()
export class FinanceGrpcController {
  private readonly logger = new Logger('FinanceGrpc');
  constructor(
    private readonly queries: FundQueryService,
    private readonly config: ConfigService,
    private readonly commands: FundCommandService,
    private readonly receipts: FundCommandRepository,
    private readonly contributions: ContributionCommandService,
    private readonly contributionQueries: ContributionQueryService,
    private readonly files?: ReceiptService,
    private readonly manual?: ManualContributionService,
    private readonly instructions?: PaymentInstructionService,
    private readonly reversals?: ContributionReversalService,
    private readonly expenses?: ExpenseService,
    private readonly financialNotes?: FinancialNoteService,
    private readonly refunds?: RefundService,
    private readonly closures?: ClosureService,
    private readonly payments?: PaymentService,
    private readonly lifecycle?: LifecycleFinanceRepository,
  ) {}

  @GrpcMethod('FinanceService', 'ExecuteTripOperation')
  executeTripOperation(
    request: FinanceV1.ExecuteTripOperationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<FinanceV1.ExecuteTripOperationResponse> {
    return this.execute('ExecuteTripOperation', metadata, call, async () => {
      if (!this.lifecycle) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return { receipt: await this.lifecycle.execute(request) };
    });
  }

  @GrpcMethod('FinanceService', 'CreatePaymentAttempt')
  createPaymentAttempt(
    request: FinanceV1.CreatePaymentAttemptRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('CreatePaymentAttempt', metadata, call, (correlation, deadline) => {
      if (!this.payments) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.payments.create(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'GetPaymentAttempt')
  getPaymentAttempt(
    request: FinanceV1.GetPaymentAttemptRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('GetPaymentAttempt', metadata, call, (correlation, deadline) => {
      if (!this.payments) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.payments.get(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ReconcilePaymentAttempt')
  reconcilePaymentAttempt(
    request: FinanceV1.ReconcilePaymentAttemptRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ReconcilePaymentAttempt', metadata, call, (correlation, deadline) => {
      if (!this.payments) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.payments.reconcile(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ReceiveMomoWebhook')
  receiveMomoWebhook(
    request: FinanceV1.ReceiveMomoWebhookRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ReceiveMomoWebhook', metadata, call, () => {
      if (!this.payments) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.payments.webhook(request);
    });
  }
  @GrpcMethod('FinanceService', 'ListPaymentExceptions')
  listPaymentExceptions(
    request: FinanceV1.ListPaymentExceptionsRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ListPaymentExceptions', metadata, call, (correlation, deadline) => {
      if (!this.payments) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.payments.listExceptions(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ResolvePaymentException')
  resolvePaymentException(
    request: FinanceV1.ResolvePaymentExceptionRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ResolvePaymentException', metadata, call, (correlation, deadline) => {
      if (!this.payments) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.payments.resolve(request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'ListClosures')
  listClosures(request: FinanceV1.ListClosuresRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('ListClosures', metadata, call, (correlation, deadline) => {
      if (!this.closures) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.closures.list(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'GetClosure')
  getClosure(request: FinanceV1.GetClosureRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('GetClosure', metadata, call, (correlation, deadline) => {
      if (!this.closures) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.closures.get(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'CreateClosure')
  createClosure(request: FinanceV1.CreateClosureRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('CreateClosure', metadata, call, (correlation, deadline) => {
      if (!this.closures) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.closures.create(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ConfirmClosure')
  confirmClosure(
    request: FinanceV1.ConfirmClosureRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ConfirmClosure', metadata, call, (correlation, deadline) => {
      if (!this.closures) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.closures.confirm(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'CancelClosure')
  cancelClosure(request: FinanceV1.CancelClosureRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('CancelClosure', metadata, call, (correlation, deadline) => {
      if (!this.closures) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.closures.cancel(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'RemindClosure')
  remindClosure(request: FinanceV1.RemindClosureRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('RemindClosure', metadata, call, (correlation, deadline) => {
      if (!this.closures) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.closures.remind(request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'ListRefunds')
  listRefunds(request: FinanceV1.ListRefundsRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('ListRefunds', metadata, call, (correlation, deadline) => {
      if (!this.refunds) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.refunds.list(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'CreateRefund')
  createRefund(request: FinanceV1.CreateRefundRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('CreateRefund', metadata, call, (correlation, deadline) => {
      if (!this.refunds) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.refunds.create(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ReportRefundPaid')
  reportRefundPaid(
    request: FinanceV1.ReportRefundPaidRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.refundAction('ReportRefundPaid', 'REPORT_REFUND_PAID', request, metadata, call);
  }
  @GrpcMethod('FinanceService', 'ConfirmRefundReceived')
  confirmRefundReceived(
    request: FinanceV1.ConfirmRefundReceivedRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.refundAction(
      'ConfirmRefundReceived',
      'CONFIRM_REFUND_RECEIVED',
      request,
      metadata,
      call,
    );
  }
  @GrpcMethod('FinanceService', 'ConfirmRefundNonreceipt')
  confirmRefundNonreceipt(
    request: FinanceV1.ConfirmRefundNonreceiptRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.refundAction(
      'ConfirmRefundNonreceipt',
      'CONFIRM_REFUND_NONRECEIPT',
      request,
      metadata,
      call,
    );
  }
  @GrpcMethod('FinanceService', 'CancelRefund')
  cancelRefund(request: FinanceV1.CancelRefundRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.refundAction('CancelRefund', 'CANCEL_REFUND', request, metadata, call);
  }
  @GrpcMethod('FinanceService', 'RequestRefundReversal')
  requestRefundReversal(
    request: FinanceV1.RequestRefundReversalRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.refundAction(
      'RequestRefundReversal',
      'REQUEST_REFUND_REVERSAL',
      request,
      metadata,
      call,
    );
  }
  @GrpcMethod('FinanceService', 'ConsentRefundReversal')
  consentRefundReversal(
    request: FinanceV1.ConsentRefundReversalRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.refundAction(
      'ConsentRefundReversal',
      'CONSENT_REFUND_REVERSAL',
      request,
      metadata,
      call,
    );
  }
  @GrpcMethod('FinanceService', 'ReverseRefund')
  reverseRefund(request: FinanceV1.ReverseRefundRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.refundAction('ReverseRefund', 'REVERSE_REFUND', request, metadata, call);
  }
  private refundAction(
    method:
      | 'ReportRefundPaid'
      | 'ConfirmRefundReceived'
      | 'ConfirmRefundNonreceipt'
      | 'CancelRefund'
      | 'RequestRefundReversal'
      | 'ConsentRefundReversal'
      | 'ReverseRefund',
    scope:
      | 'REPORT_REFUND_PAID'
      | 'CONFIRM_REFUND_RECEIVED'
      | 'CONFIRM_REFUND_NONRECEIPT'
      | 'CANCEL_REFUND'
      | 'REQUEST_REFUND_REVERSAL'
      | 'CONSENT_REFUND_REVERSAL'
      | 'REVERSE_REFUND',
    request:
      | FinanceV1.ReportRefundPaidRequest
      | FinanceV1.ConfirmRefundReceivedRequest
      | FinanceV1.ConfirmRefundNonreceiptRequest
      | FinanceV1.CancelRefundRequest
      | FinanceV1.RequestRefundReversalRequest
      | FinanceV1.ConsentRefundReversalRequest
      | FinanceV1.ReverseRefundRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute(method, metadata, call, (correlation, deadline) => {
      if (!this.refunds) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.refunds.manage(scope, request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'ListFinancialNotes')
  listFinancialNotes(
    request: FinanceV1.ListFinancialNotesRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ListFinancialNotes', metadata, call, (correlation, deadline) => {
      if (!this.financialNotes) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.financialNotes.list(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'CreateFinancialNote')
  createFinancialNote(
    request: FinanceV1.CreateFinancialNoteRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('CreateFinancialNote', metadata, call, (correlation, deadline) => {
      if (!this.financialNotes) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.financialNotes.create(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'UpdateFinancialNote')
  updateFinancialNote(
    request: FinanceV1.UpdateFinancialNoteRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('UpdateFinancialNote', metadata, call, (correlation, deadline) => {
      if (!this.financialNotes) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.financialNotes.manage('UPDATE_FINANCIAL_NOTE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'DeleteFinancialNote')
  deleteFinancialNote(
    request: FinanceV1.DeleteFinancialNoteRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('DeleteFinancialNote', metadata, call, (correlation, deadline) => {
      if (!this.financialNotes) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.financialNotes.manage('DELETE_FINANCIAL_NOTE', request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'ListExpenses')
  listExpenses(request: FinanceV1.ListExpensesRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('ListExpenses', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.list(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'CreateExpense')
  createExpense(request: FinanceV1.CreateExpenseRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('CreateExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.create(request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'UpdateExpense')
  updateExpense(request: FinanceV1.UpdateExpenseRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('UpdateExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('UPDATE_EXPENSE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'DeleteExpense')
  deleteExpense(request: FinanceV1.DeleteExpenseRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('DeleteExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('DELETE_EXPENSE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'SubmitExpense')
  submitExpense(request: FinanceV1.SubmitExpenseRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('SubmitExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('SUBMIT_EXPENSE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'WithdrawExpense')
  withdrawExpense(
    request: FinanceV1.WithdrawExpenseRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('WithdrawExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('WITHDRAW_EXPENSE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ConfirmExpense')
  confirmExpense(
    request: FinanceV1.ConfirmExpenseRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ConfirmExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('CONFIRM_EXPENSE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'RejectExpense')
  rejectExpense(request: FinanceV1.RejectExpenseRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('RejectExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('REJECT_EXPENSE', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ReverseExpense')
  reverseExpense(
    request: FinanceV1.ReverseExpenseRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ReverseExpense', metadata, call, (correlation, deadline) => {
      if (!this.expenses) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.expenses.manage('REVERSE_EXPENSE', request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'ReverseContribution')
  reverseContribution(
    request: FinanceV1.ReverseContributionRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ReverseContribution', metadata, call, (correlation, deadline) => {
      if (!this.reversals) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.reversals.run(request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'GetPaymentInstruction')
  getPaymentInstruction(
    request: FinanceV1.GetPaymentInstructionRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('GetPaymentInstruction', metadata, call, (correlation, deadline) => {
      if (!this.instructions) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.instructions.get(request, correlation, deadline);
    });
  }

  @GrpcMethod('FinanceService', 'ReportContributionTransfer')
  reportContributionTransfer(
    request: FinanceV1.ReportContributionTransferRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ReportContributionTransfer', metadata, call, (correlation, deadline) => {
      if (!this.manual) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.manual.run('REPORT_TRANSFER', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'ConfirmContributionReceived')
  confirmContributionReceived(
    request: FinanceV1.ConfirmContributionReceivedRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ConfirmContributionReceived', metadata, call, (correlation, deadline) => {
      if (!this.manual) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.manual.run('CONFIRM_RECEIVED', request, correlation, deadline);
    });
  }
  @GrpcMethod('FinanceService', 'RejectContributionTransfer')
  rejectContributionTransfer(
    request: FinanceV1.RejectContributionTransferRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('RejectContributionTransfer', metadata, call, (correlation, deadline) => {
      if (!this.manual) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      return this.manual.run('REJECT_TRANSFER', request, correlation, deadline);
    });
  }

  private async fileWork<T>(
    call: DeadlineCall | undefined,
    deadline: number,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    call?.once?.('cancelled', abort);
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    if (call?.cancelled || Date.now() >= deadline) abort();
    try {
      return await work(controller.signal);
    } finally {
      clearTimeout(timer);
      call?.off?.('cancelled', abort);
    }
  }
  private async execute<T>(
    method: string,
    metadata: Metadata | undefined,
    call: DeadlineCall | undefined,
    work: (correlation: string, deadline: number) => Promise<T>,
    budget = 1800,
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
    const deadline = Math.min(Date.now() + budget, Number(call?.getDeadline() ?? Infinity) - 100);
    try {
      return await work(correlation.toLowerCase(), deadline);
    } catch (error) {
      const code = error instanceof FinanceReadError ? error.code : 'SERVICE_UNAVAILABLE';
      if (!(error instanceof FinanceReadError))
        this.logger.warn(
          `FINANCE_RPC_FAILURE method=${method} code=${String((error as { code?: unknown })?.code ?? 'UNKNOWN').slice(0, 32)}`,
        );
      throw new RpcException({
        code: {
          VALIDATION_FAILED: status.INVALID_ARGUMENT,
          RESOURCE_NOT_FOUND: status.NOT_FOUND,
          PERMISSION_DENIED: status.PERMISSION_DENIED,
          SERVICE_UNAVAILABLE: status.UNAVAILABLE,
          STATE_CONFLICT: status.FAILED_PRECONDITION,
          VERSION_CONFLICT: status.ABORTED,
          IDEMPOTENCY_CONFLICT: status.ALREADY_EXISTS,
          FINANCE_OBLIGATION_BLOCKED: status.FAILED_PRECONDITION,
        }[code],
        message: JSON.stringify({ code, details: null }),
      });
    }
  }
  @GrpcMethod('FinanceService', 'UploadFinanceReceipt')
  uploadFinanceReceipt(
    request: FinanceV1.UploadFinanceReceiptRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute(
      'UploadFinanceReceipt',
      metadata,
      call,
      (correlation, deadline) => {
        if (!this.files) throw new FinanceReadError('SERVICE_UNAVAILABLE');
        return this.fileWork(call, deadline, (signal) =>
          this.files!.upload(request, correlation, deadline, signal),
        );
      },
      29000,
    );
  }
  @GrpcMethod('FinanceService', 'DownloadFinanceReceipt')
  downloadFinanceReceipt(
    request: FinanceV1.DownloadFinanceReceiptRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute(
      'DownloadFinanceReceipt',
      metadata,
      call,
      (correlation, deadline) => {
        if (!this.files) throw new FinanceReadError('SERVICE_UNAVAILABLE');
        return this.fileWork(call, deadline, (signal) =>
          this.files!.download(request, correlation, deadline, signal),
        );
      },
      29000,
    );
  }
  @GrpcMethod('FinanceService', 'UpdateContributionRequest')
  updateContributionRequest(
    request: FinanceV1.UpdateContributionRequestRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('UpdateContributionRequest', metadata, call, (correlation, deadline) =>
      this.contributions.manage('UPDATE_CONTRIBUTION_REQUEST', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'UpdateContributionAmount')
  updateContributionAmount(
    request: FinanceV1.UpdateContributionAmountRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('UpdateContributionAmount', metadata, call, (correlation, deadline) =>
      this.contributions.manage('UPDATE_CONTRIBUTION_AMOUNT', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'WaiveContribution')
  waiveContribution(
    request: FinanceV1.WaiveContributionRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('WaiveContribution', metadata, call, (correlation, deadline) =>
      this.contributions.manage('WAIVE_CONTRIBUTION', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'CancelContribution')
  cancelContribution(
    request: FinanceV1.CancelContributionRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('CancelContribution', metadata, call, (correlation, deadline) =>
      this.contributions.manage('CANCEL_CONTRIBUTION', request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'CreateContributionRequest')
  createContributionRequest(
    request: FinanceV1.CreateContributionRequestRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('CreateContributionRequest', metadata, call, (correlation, deadline) =>
      this.contributions.create(request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'ListContributionRequests')
  listContributionRequests(
    request: FinanceV1.ListContributionRequestsRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ListContributionRequests', metadata, call, (correlation, deadline) =>
      this.contributionQueries.listRequests(request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'ListContributions')
  listContributions(
    request: FinanceV1.ListContributionsRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ListContributions', metadata, call, (correlation, deadline) =>
      this.contributionQueries.listContributions(request, correlation, deadline),
    );
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
        if (!fundCommandScope(row.command_scope) && !lifecycleCommandScope(row.command_scope))
          throw new FinanceReadError('SERVICE_UNAVAILABLE');
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
    return this.execute('CancelOperationIfNotCommitted', metadata, call, async () => {
      if (lifecycleCommandScope(request.command_scope ?? '')) {
        if (!this.lifecycle) throw new FinanceReadError('SERVICE_UNAVAILABLE');
        return { receipt: await this.lifecycle.cancel(request) };
      }
      return { receipt: receiptView(await this.receipts.cancel(request)) };
    });
  }
  @GrpcMethod('FinanceService', 'GetFund')
  getFund(request: FinanceV1.GetFundRequest, metadata?: Metadata, call?: DeadlineCall) {
    return this.execute('GetFund', metadata, call, (correlation, deadline) =>
      this.queries.getFund(request, correlation, deadline),
    );
  }
  @GrpcMethod('FinanceService', 'ListFundTransactions')
  listFundTransactions(
    request: FinanceV1.ListFundTransactionsRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ) {
    return this.execute('ListFundTransactions', metadata, call, (correlation, deadline) =>
      this.queries.listFundTransactions(request, correlation, deadline),
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
