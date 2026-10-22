import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import {
  GRPC_LOADER_OPTIONS,
  CommonV1,
  PROTO_PATHS,
  type FinanceV1,
  type TripV1,
} from '@wolfari/contracts/grpc';
import {
  FundCommandRepository,
  fundCommandHash,
  receiptView,
  type FundWrite,
} from '../repositories/fund-command.repository';
import { FundRepository } from '../repositories/fund.repository';
import { FundQueryService } from './fund-query.service';
import {
  parseEnableFundInput,
  parseUpdateFundBudgetInput,
  FundSetupInputError,
} from '../inputs/fund-setup.input';
import {
  parseConfirmPaymentDestinationInput,
  parseCreatePaymentDestinationInput,
  parseUpdatePaymentDestinationInput,
  PaymentDestinationInputError,
} from '../inputs/payment-destination.input';
import {
  FinanceReadError,
  loopbackTarget,
  readUuid,
  type FinanceReadErrorCode,
} from '../finance.errors';
import { isManualWrite } from '../repositories/manual-contribution.repository';
import { isContributionReversalWrite } from '../repositories/contribution-reversal.repository';
import { isExpenseWrite } from '../repositories/expense.repository';
import { isFinancialNoteWrite } from '../repositories/financial-note.repository';
import { isRefundWrite } from '../repositories/refund.repository';

type CommandResponse = FinanceV1.EnableFundResponse &
  FinanceV1.ConfirmPaymentDestinationResponse &
  FinanceV1.CreateContributionRequestResponse &
  FinanceV1.UpdateContributionAmountResponse &
  FinanceV1.ReverseContributionResponse &
  FinanceV1.CreateExpenseResponse &
  FinanceV1.UpdateExpenseResponse &
  FinanceV1.DeleteExpenseResponse &
  FinanceV1.SubmitExpenseResponse &
  FinanceV1.WithdrawExpenseResponse &
  FinanceV1.ConfirmExpenseResponse &
  FinanceV1.RejectExpenseResponse &
  FinanceV1.ReverseExpenseResponse &
  FinanceV1.CreateFinancialNoteResponse &
  FinanceV1.UpdateFinancialNoteResponse &
  FinanceV1.DeleteFinancialNoteResponse &
  FinanceV1.CreateRefundResponse &
  FinanceV1.ReportRefundPaidResponse &
  FinanceV1.ConfirmRefundReceivedResponse &
  FinanceV1.ConfirmRefundNonreceiptResponse &
  FinanceV1.CancelRefundResponse &
  FinanceV1.RequestRefundReversalResponse &
  FinanceV1.ConsentRefundReversalResponse &
  FinanceV1.ReverseRefundResponse;
const service = loadSync(PROTO_PATHS.trip, GRPC_LOADER_OPTIONS)[
  'wolfari.trip.v1.TripService'
] as ServiceDefinition;
@Injectable()
export class FundTripClient implements OnApplicationShutdown {
  private client?: Client;
  constructor(private readonly config: ConfigService) {}
  call<T>(
    name: 'BeginFinanceOperation' | 'CompleteOperation',
    request: object,
    correlation: string,
    deadline: number,
  ): Promise<T> {
    const target = this.config.get<string>('TRIP_GRPC_TARGET') ?? '';
    const secret = this.config.get<string>('FINANCE_TRIP_SECRET') ?? '';
    if (
      !loopbackTarget(target) ||
      secret.length < 32 ||
      Date.now() >= deadline ||
      this.config.get('NODE_ENV') === 'production'
    )
      return Promise.reject(new FinanceReadError('SERVICE_UNAVAILABLE'));
    this.client ??= new Client(target, credentials.createInsecure());
    const method = service[name] as unknown as MethodDefinition<object, T>;
    // A shared subchannel may still be reconnecting after Trip restarts.
    // Wait only within the original request deadline; never extend its budget.
    const metadata = new Metadata({ waitForReady: true });
    metadata.set('x-caller-service', 'Finance');
    metadata.set('x-service-secret', secret);
    metadata.set('x-correlation-id', correlation);
    return new Promise((resolve, reject) =>
      this.client!.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline },
        (error, response) => (error ? reject(error) : resolve(response as T)),
      ),
    );
  }
  onApplicationShutdown() {
    this.client?.close();
  }
}
function tripError(error: unknown): FinanceReadError {
  try {
    const value = JSON.parse((error as { details: string }).details) as {
      code: FinanceReadErrorCode;
    };
    if (
      [
        'VALIDATION_FAILED',
        'PERMISSION_DENIED',
        'RESOURCE_NOT_FOUND',
        'STATE_CONFLICT',
        'VERSION_CONFLICT',
        'IDEMPOTENCY_CONFLICT',
      ].includes(value.code)
    )
      return new FinanceReadError(value.code);
  } catch {
    /* Raw transport/auth failures are not trusted user denials. */
  }
  return new FinanceReadError('SERVICE_UNAVAILABLE');
}
const defined = (value: object) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
const destinationFields = (value?: FinanceV1.DestinationPatch | FinanceV1.DestinationWrite) =>
  defined({
    destination_type: value?.destination_type,
    active: value?.active,
    is_default: value?.is_default,
    bank_code: value?.bank_code,
    account_number: value?.account_number,
    account_name: value?.account_name,
    momo_phone: value?.momo_phone,
  });
type UnhashedWrite = FundWrite extends infer T
  ? T extends FundWrite
    ? Omit<T, 'hash'>
    : never
  : never;
type ConfigurationMutation = FundWrite extends infer T
  ? T extends {
      scope: 'UPDATE_FUND_BUDGET' | 'CREATE_PAYMENT_DESTINATION' | 'UPDATE_PAYMENT_DESTINATION';
    }
    ? Omit<T, 'hash' | 'operationId' | 'actor' | 'fundId' | 'tripId'>
    : never
  : never;
@Injectable()
export class FundCommandService {
  constructor(
    private readonly repo: FundCommandRepository,
    private readonly funds: FundRepository,
    private readonly queries: FundQueryService,
    private readonly trip: FundTripClient,
  ) {}
  async enable(
    request: FinanceV1.EnableFundRequest,
    correlation: string,
    deadline: number,
  ): Promise<CommandResponse> {
    try {
      const body = parseEnableFundInput(
        defined({
          holder_user_id: request.holder_user_id,
          currency: request.currency,
          budget_amount: request.budget_amount,
          // proto-loader oneofs:true adds synthetic _field presence properties.
          // Project actual fields explicitly before applying the strict JSON parser.
          destination: request.destination
            ? defined({
                destination_type: request.destination.destination_type,
                is_default: request.destination.is_default,
                active: request.destination.active,
                bank_code: request.destination.bank_code,
                account_number: request.destination.account_number,
                account_name: request.destination.account_name,
                momo_phone: request.destination.momo_phone,
              })
            : undefined,
        }),
      );
      return await this.run(
        {
          scope: 'ENABLE_FUND',
          operationId: readUuid(request.operation_id),
          actor: readUuid(request.actor_user_id),
          tripId: readUuid(request.trip_id),
          body,
        },
        correlation,
        deadline,
      );
    } catch (error) {
      if (error instanceof FundSetupInputError) throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
  async confirm(
    request: FinanceV1.ConfirmPaymentDestinationRequest,
    correlation: string,
    deadline: number,
  ): Promise<CommandResponse> {
    try {
      const body = parseConfirmPaymentDestinationInput({
        expected_version: request.expected_version,
        expected_finance_version: request.expected_finance_version,
      });
      const operationId = readUuid(request.operation_id),
        actor = readUuid(request.actor_user_id),
        fundId = readUuid(request.fund_id),
        destinationId = readUuid(request.destination_id);
      const fund = await this.funds.findScopeById(fundId);
      if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      return await this.run(
        {
          scope: 'CONFIRM_PAYMENT_DESTINATION',
          operationId,
          actor,
          tripId: fund.tripId,
          fundId,
          destinationId,
          body,
        },
        correlation,
        deadline,
      );
    } catch (error) {
      if (error instanceof PaymentDestinationInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
  async configure(
    command: 'UPDATE_FUND_BUDGET' | 'CREATE_PAYMENT_DESTINATION' | 'UPDATE_PAYMENT_DESTINATION',
    request: FinanceV1.UpdateFundBudgetRequest &
      FinanceV1.CreatePaymentDestinationRequest &
      FinanceV1.UpdatePaymentDestinationRequest,
    correlation: string,
    deadline: number,
  ): Promise<CommandResponse> {
    try {
      const operationId = readUuid(request.operation_id),
        actor = readUuid(request.actor_user_id),
        fundId = readUuid(request.fund_id);
      let mutation: ConfigurationMutation;
      if (command === 'UPDATE_FUND_BUDGET') {
        const budget = request.budget;
        const hasValue = budget?.value !== undefined;
        const hasClear = budget?.clear !== undefined;
        if (hasValue === hasClear || (hasClear && budget?.clear !== true))
          throw new FinanceReadError('VALIDATION_FAILED');
        mutation = {
          scope: command,
          body: parseUpdateFundBudgetInput({
            budget_amount: hasClear ? null : budget!.value,
            expected_finance_version: request.expected_finance_version,
          }),
        };
      } else if (command === 'CREATE_PAYMENT_DESTINATION') {
        mutation = {
          scope: command,
          body: parseCreatePaymentDestinationInput({
            ...destinationFields(request.destination),
            expected_finance_version: request.expected_finance_version,
          }),
        };
      } else {
        mutation = {
          scope: command,
          destinationId: readUuid(request.destination_id),
          body: parseUpdatePaymentDestinationInput({
            ...destinationFields(request.patch),
            expected_version: request.expected_version,
            expected_finance_version: request.expected_finance_version,
          }),
        };
      }
      const fund = await this.funds.findScopeById(fundId);
      if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
      return await this.run(
        { ...mutation, operationId, actor, fundId, tripId: fund.tripId },
        correlation,
        deadline,
      );
    } catch (error) {
      if (error instanceof FundSetupInputError || error instanceof PaymentDestinationInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
  /** Shared durable command coordinator; callers must parse inputs and resolve Fund scope first. */
  async run(
    command: UnhashedWrite,
    correlation: string,
    deadline: number,
    prepare?: () => Promise<void>,
  ): Promise<CommandResponse> {
    const { operationId, ...intent } = command;
    const input = { ...command, hash: fundCommandHash(intent) } as FundWrite;
    const pending = (): CommandResponse => ({
      operation: { operation_id: operationId, trip_id: input.tripId, state: 2 },
    });
    let saved = await this.repo.find(operationId);
    if (saved) this.repo.verify(saved, input);
    else {
      // External storage verification happens before the guard/SQL write and is skipped on replay.
      await prepare?.();
      if (prepare && Date.now() >= deadline) throw new FinanceReadError('SERVICE_UNAVAILABLE');
      let guard: TripV1.BeginFinanceOperationResponse;
      try {
        guard = await this.trip.call(
          'BeginFinanceOperation',
          {
            operation_id: operationId,
            trip_id: input.tripId,
            actor: { actor_user_id: input.actor },
            command: input.scope,
            request_hash: input.hash,
          },
          correlation,
          deadline,
        );
      } catch (error) {
        throw tripError(error);
      }
      // An acknowledged guard survives a local timeout/crash. Recovery will query/cancel it.
      try {
        saved = await this.repo.execute(input, guard, correlation);
      } catch (error) {
        if (error instanceof FinanceReadError) throw error;
        return pending();
      }
    }
    let completed: TripV1.CompleteOperationResponse;
    try {
      completed = await this.trip.call<TripV1.CompleteOperationResponse>(
        'CompleteOperation',
        {
          operation_id: operationId,
          actor: { actor_user_id: input.actor },
          request_hash: input.hash,
          finance_outcome: receiptView(saved).outcome,
        },
        correlation,
        deadline,
      );
      if (
        completed.operation?.operation_id !== operationId ||
        completed.operation.trip_id !== input.tripId ||
        completed.operation.state !== (saved.status === 'COMMITTED' ? 3 : 4)
      )
        throw new Error('Invalid completion');
    } catch {
      return pending();
    }
    if (saved.status !== 'COMMITTED')
      throw new FinanceReadError(saved.response.error ?? 'STATE_CONFLICT');
    if (isRefundWrite(input)) {
      const current = await this.queries.getFund(
        { trip_id: input.tripId, actor_user_id: input.actor },
        correlation,
        deadline,
      );
      const role = await this.queries.authorizeFundRead(
        input.fundId,
        input.actor,
        correlation,
        deadline,
      );
      const row = saved.response.refund;
      if (
        !row ||
        row.fund_id !== input.fundId ||
        ('refundId' in input && row.id !== input.refundId) ||
        !row.finance_version
      )
        throw new Error('Invalid refund result');
      const ownerScopes = ['CREATE_REFUND', 'CANCEL_REFUND'];
      const holderScopes = ['REPORT_REFUND_PAID', 'REQUEST_REFUND_REVERSAL', 'REVERSE_REFUND'];
      const recipientScopes = [
        'CONFIRM_REFUND_RECEIVED',
        'CONFIRM_REFUND_NONRECEIPT',
        'CONSENT_REFUND_REVERSAL',
      ];
      if (
        (ownerScopes.includes(input.scope) &&
          role !== CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER) ||
        (holderScopes.includes(input.scope) && current.fund?.holder_user_id !== input.actor) ||
        (recipientScopes.includes(input.scope) && row.member_user_id !== input.actor)
      )
        throw new FinanceReadError('PERMISSION_DENIED');
      return { refund: row };
    }
    if (isExpenseWrite(input)) {
      await this.queries.getFund(
        { trip_id: input.tripId, actor_user_id: input.actor },
        correlation,
        deadline,
      );
      if (input.scope === 'DELETE_EXPENSE') return { operation: completed.operation };
      const row = saved.response.expense;
      if (
        !row ||
        row.fund_id !== input.fundId ||
        ('expenseId' in input && row.id !== input.expenseId) ||
        !row.finance_version
      )
        throw new Error('Invalid expense result');
      return { expense: row };
    }
    if (isFinancialNoteWrite(input)) {
      const role = await this.queries.authorizeFundRead(
        input.fundId,
        input.actor,
        correlation,
        deadline,
      );
      const row = saved.response.financialNote;
      if (
        input.scope !== 'CREATE_FINANCIAL_NOTE' &&
        (!row ||
          (row.created_by_user_id !== input.actor &&
            role !== CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER))
      )
        throw new FinanceReadError('PERMISSION_DENIED');
      if (input.scope === 'DELETE_FINANCIAL_NOTE') return { operation: completed.operation };
      if (
        !row ||
        row.fund_id !== input.fundId ||
        ('noteId' in input && row.id !== input.noteId) ||
        !row.finance_version
      )
        throw new Error('Invalid financial note result');
      return { financial_note: row };
    }
    if ('requestId' in input) {
      const current = await this.queries.getFund(
        { trip_id: input.tripId, actor_user_id: input.actor },
        correlation,
        deadline,
      );
      if (input.scope === 'UPDATE_CONTRIBUTION_REQUEST') {
        const row = saved.response.contributionRequest;
        if (
          !row ||
          row.id !== input.requestId ||
          row.fund_id !== input.fundId ||
          !Array.isArray(row.contributions) ||
          !row.finance_version
        )
          throw new Error('Invalid request update snapshot');
        return { contribution_request: row };
      }
      const row = saved.response.contribution;
      if (
        !row ||
        row.id !== input.contributionId ||
        row.request_id !== input.requestId ||
        row.fund_id !== input.fundId ||
        !row.finance_version
      )
        throw new Error('Invalid contribution update snapshot');
      if (
        (isContributionReversalWrite(input) || isManualWrite(input)) &&
        input.actor !==
          (input.scope === 'REPORT_TRANSFER' ? row.member_user_id : current.fund?.holder_user_id)
      )
        throw new FinanceReadError('PERMISSION_DENIED');
      return { contribution: row };
    }
    // Persisted snapshots guarantee repeatability. Reauthorize private reads even on terminal replay.
    if (
      input.scope === 'ENABLE_FUND' ||
      input.scope === 'UPDATE_FUND_BUDGET' ||
      input.scope === 'CREATE_CONTRIBUTION_REQUEST'
    ) {
      await this.queries.getFund(
        { trip_id: input.tripId, actor_user_id: input.actor },
        correlation,
        deadline,
      );
      if (input.scope === 'CREATE_CONTRIBUTION_REQUEST') {
        if (
          !saved.response.contributionRequest ||
          saved.response.contributionRequest.fund_id !== input.fundId
        )
          throw new Error('Missing contribution request result');
        const snapshot = saved.response.contributionRequest;
        const hasRows = Object.hasOwn(snapshot, 'contributions');
        const hasVersion = Object.hasOwn(snapshot, 'finance_version');
        if (
          hasRows !== hasVersion ||
          (hasRows && (!Array.isArray(snapshot.contributions) || !snapshot.contributions.length))
        )
          throw new Error('Incomplete contribution creation snapshot');
        return { contribution_request: saved.response.contributionRequest };
      }
      if (!saved.response.fund) throw new Error('Missing Fund result');
      return { fund: saved.response.fund };
    }
    const current = await this.queries.listPaymentDestinations(
      { fund_id: input.fundId, actor_user_id: input.actor },
      correlation,
      deadline,
    );
    const destinationId =
      input.scope === 'CREATE_PAYMENT_DESTINATION'
        ? saved.response.destination?.id
        : input.destinationId;
    const destination = current.destinations?.find((d) => d.id === destinationId);
    if (!destination || (!destination.account_number && !destination.momo_phone))
      throw new FinanceReadError('RESOURCE_NOT_FOUND');
    if (!saved.response.destination) throw new Error('Missing destination result');
    return { destination: saved.response.destination };
  }
}
