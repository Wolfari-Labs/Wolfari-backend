import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { createHash } from 'node:crypto';
import { CommonV1, FinanceV1, TripV1 } from '@wolfari/contracts/grpc';
import {
  assertCanEnableFund,
  assertCanUpdateFundBudget,
  type UpdateFundBudgetCommand,
  type FundSetupContext,
  FundSetupConflictError,
  FundSetupPermissionDeniedError,
  FundSetupValidationError,
  type EnableFundCommand,
  type FundDestination,
} from '../domain/fund-setup';
import {
  prepareConfirmPaymentDestination,
  prepareCreatePaymentDestination,
  prepareUpdatePaymentDestination,
  type CreatePaymentDestinationCommand,
  type UpdatePaymentDestinationCommand,
  type PaymentDestinationState,
  PaymentDestinationConflictError,
  PaymentDestinationPermissionError,
  PaymentDestinationValidationError,
  type DestinationVersions,
} from '../domain/payment-destination-management';
import { FinanceReadError, type FinanceReadErrorCode, readUuid } from '../finance.errors';
import { destinationResponse, fundResponse } from '../projections/fund-response';
import { FundRepository } from './fund.repository';
import type { DestinationListRow } from './payment-destination-query.repository';
import { ContributionCommandRepository } from './contribution-command.repository';
import {
  ContributionRequestCreationConflictError,
  type CreateContributionRequestCommand,
} from '../domain/contribution-request-creation';
import { InvalidContributionRequestError } from '../domain/contribution-request';
import { ContributionPermissionDeniedError } from '../domain/contribution-permissions';

import {
  ContributionManagementRepository,
  type ManagementWrite,
} from './contribution-management.repository';
import { ContributionManagementError } from '../domain/contribution-management';
import { ReceiptRepository } from '../receipts/receipt.repository';
import {
  ManualContributionRepository,
  isManualWrite,
  type ManualWrite,
} from './manual-contribution.repository';
import {
  ContributionStateConflictError,
  ContributionVersionConflictError,
} from '../domain/contribution-transition';
import {
  ContributionReversalRepository,
  isContributionReversalWrite,
  type ContributionReversalWrite,
} from './contribution-reversal.repository';
import {
  ExpenseRepository,
  isExpenseWrite,
  mapExpenseRuleError,
  type ExpenseWriteCommand,
} from './expense.repository';
import {
  FinancialNoteRepository,
  isFinancialNoteWrite,
  mapFinancialNoteRuleError,
  type FinancialNoteWriteCommand,
} from './financial-note.repository';
import {
  RefundRepository,
  isRefundWrite,
  mapRefundRuleError,
  type RefundWriteCommand,
} from './refund.repository';

export type FundWrite = {
  operationId: string;
  actor: string;
  tripId: string;
  hash: string;
} & (
  | ManualWrite
  | ContributionReversalWrite
  | ExpenseWriteCommand
  | FinancialNoteWriteCommand
  | RefundWriteCommand
  | ManagementWrite
  | { scope: 'CREATE_CONTRIBUTION_REQUEST'; fundId: string; body: CreateContributionRequestCommand }
  | { scope: 'ENABLE_FUND'; body: EnableFundCommand }
  | { scope: 'UPDATE_FUND_BUDGET'; fundId: string; body: UpdateFundBudgetCommand }
  | { scope: 'CREATE_PAYMENT_DESTINATION'; fundId: string; body: CreatePaymentDestinationCommand }
  | {
      scope: 'UPDATE_PAYMENT_DESTINATION';
      fundId: string;
      destinationId: string;
      body: UpdatePaymentDestinationCommand;
    }
  | {
      scope: 'CONFIRM_PAYMENT_DESTINATION';
      fundId: string;
      destinationId: string;
      body: DestinationVersions;
    }
);
export type StoredResult = {
  version: 1;
  tripId: string;
  error?: FinanceReadErrorCode;
  fund?: FinanceV1.FundView;
  destination?: FinanceV1.PaymentDestinationView;
  contributionRequest?: FinanceV1.ContributionRequestView;
  contribution?: FinanceV1.ContributionView;
  expense?: FinanceV1.ExpenseView;
  financialNote?: FinanceV1.FinancialNoteView;
  refund?: FinanceV1.RefundView;
};
export type FundReceipt = {
  operation_id: string;
  actor_user_id: string;
  command_scope: string;
  request_hash: string;
  status: 'COMMITTED' | 'REJECTED' | 'CANCELLED';
  response: StoredResult;
  completed_at: Date;
};
type Client = Pick<DatabaseProvider, 'query'>;
export const fundCommandScope = (value: string) =>
  [
    'REPORT_TRANSFER',
    'CONFIRM_RECEIVED',
    'REJECT_TRANSFER',
    'REVERSE_CONTRIBUTION',
    'CREATE_EXPENSE',
    'UPDATE_EXPENSE',
    'DELETE_EXPENSE',
    'SUBMIT_EXPENSE',
    'WITHDRAW_EXPENSE',
    'CONFIRM_EXPENSE',
    'REJECT_EXPENSE',
    'REVERSE_EXPENSE',
    'CREATE_FINANCIAL_NOTE',
    'UPDATE_FINANCIAL_NOTE',
    'DELETE_FINANCIAL_NOTE',
    'CREATE_REFUND',
    'REPORT_REFUND_PAID',
    'CONFIRM_REFUND_RECEIVED',
    'CONFIRM_REFUND_NONRECEIPT',
    'CANCEL_REFUND',
    'REQUEST_REFUND_REVERSAL',
    'CONSENT_REFUND_REVERSAL',
    'REVERSE_REFUND',
    'UPDATE_CONTRIBUTION_REQUEST',
    'UPDATE_CONTRIBUTION_AMOUNT',
    'WAIVE_CONTRIBUTION',
    'CANCEL_CONTRIBUTION',
    'CREATE_CONTRIBUTION_REQUEST',
    'ENABLE_FUND',
    'CONFIRM_PAYMENT_DESTINATION',
    'UPDATE_FUND_BUDGET',
    'CREATE_PAYMENT_DESTINATION',
    'UPDATE_PAYMENT_DESTINATION',
  ].includes(value);
/** Hash normalized inputs, never JSON key order or transport defaults. */
export function fundCommandHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (typeof input === 'bigint') return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical({ version: 1, input: value })))
    .digest('hex');
}
export function receiptView(row: FundReceipt): CommonV1.Receipt {
  if (!fundCommandScope(row.command_scope) || row.response?.version !== 1 || !row.completed_at)
    throw new Error('Invalid stored receipt');
  const ms = row.completed_at.getTime();
  return {
    operation_id: row.operation_id,
    request_hash: row.request_hash,
    outcome: {
      status: { COMMITTED: 1, REJECTED: 2, CANCELLED: 3 }[row.status],
      blocking_ids: [],
      error_code:
        row.status === 'COMMITTED'
          ? undefined
          : row.response.error === 'VERSION_CONFLICT'
            ? 'VERSION_CONFLICT'
            : 'STATE_CONFLICT',
    },
    completed_at: { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1000000 },
  };
}
function domainError(error: unknown): FinanceReadError | undefined {
  const refund = mapRefundRuleError(error);
  if (refund) return refund;
  const note = mapFinancialNoteRuleError(error);
  if (note) return note;
  const expense = mapExpenseRuleError(error);
  if (expense) return expense;
  if (error instanceof ContributionStateConflictError)
    return new FinanceReadError('STATE_CONFLICT');
  if (error instanceof ContributionVersionConflictError)
    return new FinanceReadError('VERSION_CONFLICT');
  if (error instanceof ContributionManagementError) return new FinanceReadError(error.code);
  if (error instanceof FinanceReadError) return error;
  if (error instanceof ContributionPermissionDeniedError)
    return new FinanceReadError('PERMISSION_DENIED');
  if (error instanceof InvalidContributionRequestError)
    return new FinanceReadError('VALIDATION_FAILED');
  if (error instanceof ContributionRequestCreationConflictError)
    return new FinanceReadError(
      error.code === 'FINANCE_VERSION_CONFLICT' ? 'VERSION_CONFLICT' : 'STATE_CONFLICT',
    );
  if (
    error instanceof FundSetupPermissionDeniedError ||
    error instanceof PaymentDestinationPermissionError
  )
    return new FinanceReadError('PERMISSION_DENIED');
  if (
    error instanceof FundSetupValidationError ||
    error instanceof PaymentDestinationValidationError
  )
    return new FinanceReadError('VALIDATION_FAILED');
  if (error instanceof FundSetupConflictError || error instanceof PaymentDestinationConflictError)
    return new FinanceReadError(
      error.code.endsWith('VERSION_CONFLICT') ? 'VERSION_CONFLICT' : 'STATE_CONFLICT',
    );
  return undefined;
}

@Injectable()
export class FundCommandRepository {
  constructor(readonly db: DatabaseProvider) {}
  async find(id: string, client: Client = this.db): Promise<FundReceipt | undefined> {
    return (
      await client.query<FundReceipt>('SELECT * FROM command_receipts WHERE operation_id=$1', [id])
    ).rows[0];
  }
  verify(row: FundReceipt, input: Pick<FundWrite, 'actor' | 'scope' | 'hash' | 'tripId'>) {
    if (row.actor_user_id !== input.actor) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    if (
      row.command_scope !== input.scope ||
      row.request_hash !== input.hash ||
      row.response?.tripId !== input.tripId ||
      row.response?.version !== 1
    )
      throw new FinanceReadError('IDEMPOTENCY_CONFLICT');
  }
  private async lock(client: Client, id: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
  }
  private async save(
    client: Client,
    input: Pick<FundWrite, 'operationId' | 'actor' | 'scope' | 'hash'>,
    status: FundReceipt['status'],
    response: StoredResult,
  ) {
    return (
      await client.query<FundReceipt>(
        `INSERT INTO command_receipts
      (operation_id,actor_user_id,command_scope,idempotency_key,request_hash,status,response,completed_at)
      VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6::jsonb,clock_timestamp()) RETURNING *`,
        [input.operationId, input.actor, input.scope, input.hash, status, JSON.stringify(response)],
      )
    ).rows[0]!;
  }
  async cancel(input: FinanceV1.CancelOperationIfNotCommittedRequest): Promise<FundReceipt> {
    const ctx = input.authorization_context;
    const id = readUuid(input.operation_id),
      actor = readUuid(ctx?.actor?.actor_user_id),
      tripId = readUuid(ctx?.trip_id);
    if (
      !ctx ||
      !fundCommandScope(input.command_scope ?? '') ||
      ctx.command_scope !== input.command_scope ||
      ctx?.actor?.system_actor !== undefined ||
      !/^[a-f0-9]{64}$/.test(input.request_hash ?? '') ||
      !ctx.active_user_ids?.includes(actor) ||
      !Number.isInteger(ctx.context_revision) ||
      Number(ctx.context_revision) < 1 ||
      input.membership_target
    )
      throw new FinanceReadError('VALIDATION_FAILED');
    const command = {
      operationId: id,
      actor,
      tripId,
      scope: input.command_scope!,
      hash: input.request_hash!,
    };
    return this.db.withTransaction(async (client) => {
      await this.lock(client, id);
      const row = await this.find(id, client);
      if (row) {
        this.verify(row, command as FundWrite);
        return row;
      }
      return this.save(client, command as FundWrite, 'CANCELLED', {
        version: 1,
        tripId,
        error: 'STATE_CONFLICT',
      });
    });
  }
  async execute(
    input: FundWrite,
    guard: TripV1.BeginFinanceOperationResponse,
    correlation: string,
  ) {
    const ctx = guard.context;
    if (
      ctx?.actor?.actor_user_id !== input.actor ||
      ctx.actor.system_actor !== undefined ||
      ctx.trip_id !== input.tripId ||
      ctx.command_scope !== input.scope ||
      !ctx.active_user_ids?.includes(input.actor) ||
      !guard.owner_user_id ||
      !ctx.active_user_ids.includes(guard.owner_user_id) ||
      !Number.isInteger(ctx.context_revision) ||
      Number(ctx.context_revision) < 1 ||
      guard.closure_lock_id
    )
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const authority = {
      actorUserId: input.actor,
      ownerUserId: guard.owner_user_id,
      activeMemberUserIds: new Set(ctx.active_user_ids),
      tripArchived: false,
    };
    return this.db.withTransaction(async (client) => {
      await this.lock(client, input.operationId);
      const saved = await this.find(input.operationId, client);
      if (saved) {
        this.verify(saved, input);
        return saved;
      }
      await client.query('SAVEPOINT fund_mutation');
      try {
        let response: StoredResult;
        if (input.scope === 'ENABLE_FUND') {
          const existing = await client.query('SELECT 1 FROM funds WHERE trip_id=$1', [
            input.tripId,
          ]);
          assertCanEnableFund(input.body, { ...authority, fundExists: Boolean(existing.rowCount) });
          const fund = (
            await client.query<{ id: string }>(
              `INSERT INTO funds(trip_id,holder_user_id,currency,budget_amount)
            VALUES($1,$2,'VND',$3) ON CONFLICT(trip_id) DO NOTHING RETURNING id`,
              [input.tripId, input.body.holderUserId, input.body.budgetAmount?.toString() ?? null],
            )
          ).rows[0];
          if (!fund) throw new FinanceReadError('STATE_CONFLICT');
          const dest = input.body.destination;
          await client.query(
            `INSERT INTO payment_destinations(fund_id,destination_type,bank_code,account_number,account_name,momo_phone,is_default,active)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              fund.id,
              dest.destinationType,
              dest.destinationType === 'VIETQR' ? dest.bankCode : null,
              dest.destinationType === 'VIETQR' ? dest.accountNumber : null,
              dest.destinationType === 'VIETQR' ? dest.accountName : null,
              dest.destinationType === 'MOMO_SANDBOX' ? dest.momoPhone : null,
              dest.isDefault,
              dest.active,
            ],
          );
          await this.audit(client, input, correlation, fund.id, 'Fund', fund.id, null, 1);
          response = {
            version: 1,
            tripId: input.tripId,
            fund: {
              id: fund.id,
              trip_id: input.tripId,
              holder_user_id: input.body.holderUserId,
              currency: 'VND',
              budget_amount: input.body.budgetAmount?.toString(),
              current_balance: '0',
              reserved_refund: '0',
              available_balance: '0',
              status: 1,
              finance_version: 1,
            },
          };
        } else if (input.scope === 'CREATE_CONTRIBUTION_REQUEST') {
          response = await new ContributionCommandRepository().create(
            client,
            input,
            authority,
            correlation,
          );
        } else if (isManualWrite(input)) {
          response = await new ManualContributionRepository(new ReceiptRepository(this.db)).execute(
            client,
            input,
            authority,
            correlation,
          );
        } else if (isContributionReversalWrite(input)) {
          response = await new ContributionReversalRepository().execute(
            client,
            input,
            authority,
            correlation,
          );
        } else if (isExpenseWrite(input)) {
          response = await new ExpenseRepository(client, new ReceiptRepository(this.db)).execute(
            client,
            input,
            authority,
            correlation,
          );
        } else if (isFinancialNoteWrite(input)) {
          response = await new FinancialNoteRepository(client).execute(
            client,
            input,
            authority,
            correlation,
          );
        } else if (isRefundWrite(input)) {
          response = await new RefundRepository(client).execute(
            client,
            input,
            authority,
            correlation,
          );
        } else if ('requestId' in input) {
          response = await new ContributionManagementRepository().execute(
            client,
            input,
            authority,
            correlation,
          );
        } else if (input.scope !== 'CONFIRM_PAYMENT_DESTINATION') {
          response = await this.configure(client, input, authority, correlation);
        } else {
          const fund = (
            await client.query<{
              holder_user_id: string;
              status: 'OPEN' | 'CLOSING' | 'CLOSED';
              finance_version: number;
            }>('SELECT * FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE', [
              input.fundId,
              input.tripId,
            ])
          ).rows[0];
          if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
          let dest = (
            await client.query<DestinationListRow>(
              'SELECT * FROM payment_destinations WHERE fund_id=$1 AND id=$2 FOR UPDATE',
              [input.fundId, input.destinationId],
            )
          ).rows[0];
          if (!dest) throw new FinanceReadError('RESOURCE_NOT_FOUND');
          const configuration: FundDestination =
            dest.destination_type === 'VIETQR'
              ? {
                  destinationType: 'VIETQR',
                  isDefault: dest.is_default,
                  active: dest.active,
                  bankCode: dest.bank_code!,
                  accountNumber: dest.account_number!,
                  accountName: dest.account_name!,
                }
              : {
                  destinationType: 'MOMO_SANDBOX',
                  isDefault: dest.is_default,
                  active: dest.active,
                  momoPhone: dest.momo_phone!,
                };
          const plan = prepareConfirmPaymentDestination(
            input.body,
            {
              ...authority,
              fundId: input.fundId,
              holderUserId: fund.holder_user_id,
              fundStatus: fund.status,
              financeVersion: fund.finance_version,
            },
            {
              id: dest.id,
              fundId: dest.fund_id,
              version: dest.version,
              confirmedByHolderAt: dest.confirmed_by_holder_at,
              configuration,
            },
          );
          if (plan.changed) {
            dest = (
              await client.query<DestinationListRow>(
                `UPDATE payment_destinations SET confirmed_by_holder_at=clock_timestamp(),
              version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
                [dest.id],
              )
            ).rows[0]!;
            await client.query(
              'UPDATE funds SET finance_version=finance_version+1,updated_at=clock_timestamp() WHERE id=$1',
              [input.fundId],
            );
            await this.audit(
              client,
              input,
              correlation,
              input.fundId,
              'PaymentDestination',
              dest.id,
              dest.version - 1,
              dest.version,
            );
          }
          response = {
            version: 1,
            tripId: input.tripId,
            destination: destinationResponse(dest, true),
          };
        }
        await client.query('RELEASE SAVEPOINT fund_mutation');
        return this.save(client, input, 'COMMITTED', response);
      } catch (error) {
        const mapped = domainError(error);
        if (!mapped || mapped.code === 'SERVICE_UNAVAILABLE') throw error;
        await client.query('ROLLBACK TO SAVEPOINT fund_mutation');
        return this.save(client, input, 'REJECTED', {
          version: 1,
          tripId: input.tripId,
          error: mapped.code,
        });
      }
    });
  }
  private async configure(
    client: Client,
    input: Extract<
      FundWrite,
      { scope: 'UPDATE_FUND_BUDGET' | 'CREATE_PAYMENT_DESTINATION' | 'UPDATE_PAYMENT_DESTINATION' }
    >,
    authority: FundSetupContext,
    correlation: string,
  ): Promise<StoredResult> {
    const fund = (
      await client.query<{
        holder_user_id: string;
        status: 'OPEN' | 'CLOSING' | 'CLOSED';
        finance_version: number;
        budget_amount: string | null;
      }>('SELECT * FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE', [input.fundId, input.tripId])
    ).rows[0];
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const context = {
      ...authority,
      fundId: input.fundId,
      holderUserId: fund.holder_user_id,
      fundStatus: fund.status,
      financeVersion: fund.finance_version,
    };
    if (input.scope === 'UPDATE_FUND_BUDGET') {
      assertCanUpdateFundBudget(input.body, context);
      const budget = input.body.budgetAmount?.toString() ?? null;
      if (budget !== fund.budget_amount) {
        if (fund.finance_version === 2147483647) throw new FinanceReadError('STATE_CONFLICT');
        await client.query(
          `UPDATE funds SET budget_amount=$2,finance_version=finance_version+1,
          updated_at=clock_timestamp() WHERE id=$1`,
          [input.fundId, budget],
        );
        await this.audit(
          client,
          input,
          correlation,
          input.fundId,
          'Fund',
          input.fundId,
          fund.finance_version,
          fund.finance_version + 1,
        );
      }
      const summary = await new FundRepository(client).findSummaryByTripId(input.tripId);
      if (!summary) throw new Error('Missing locked Fund');
      return { version: 1, tripId: input.tripId, fund: fundResponse(summary) };
    }
    const state = (row: DestinationListRow): PaymentDestinationState => ({
      id: row.id,
      fundId: row.fund_id,
      version: row.version,
      confirmedByHolderAt: row.confirmed_by_holder_at,
      configuration:
        row.destination_type === 'VIETQR'
          ? {
              destinationType: 'VIETQR',
              active: row.active,
              isDefault: row.is_default,
              bankCode: row.bank_code!,
              accountNumber: row.account_number!,
              accountName: row.account_name!,
            }
          : {
              destinationType: 'MOMO_SANDBOX',
              active: row.active,
              isDefault: row.is_default,
              momoPhone: row.momo_phone!,
            },
    });
    let target: DestinationListRow | undefined;
    if (input.scope === 'UPDATE_PAYMENT_DESTINATION') {
      target = (
        await client.query<DestinationListRow>(
          'SELECT * FROM payment_destinations WHERE fund_id=$1 AND id=$2 FOR UPDATE',
          [input.fundId, input.destinationId],
        )
      ).rows[0];
      if (!target) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    }
    const type =
      input.scope === 'CREATE_PAYMENT_DESTINATION'
        ? input.body.destination.destinationType
        : target!.destination_type;
    const current = (
      await client.query<DestinationListRow>(
        `SELECT * FROM payment_destinations WHERE fund_id=$1 AND destination_type=$2
       AND active AND is_default FOR UPDATE`,
        [input.fundId, type],
      )
    ).rows[0];
    const plan =
      input.scope === 'CREATE_PAYMENT_DESTINATION'
        ? prepareCreatePaymentDestination(input.body, context, current ? state(current) : null)
        : prepareUpdatePaymentDestination(
            input.body,
            context,
            state(target!),
            current ? state(current) : null,
          );
    if (plan.demoteDefault) {
      // Fund lock serializes changes, including insertions where there is no destination row yet.
      const demoted = await client.query(
        `UPDATE payment_destinations SET is_default=false,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND fund_id=$2 AND version=$3`,
        [plan.demoteDefault.id, input.fundId, plan.demoteDefault.expectedVersion],
      );
      if (demoted.rowCount !== 1) throw new FinanceReadError('VERSION_CONFLICT');
      await this.audit(
        client,
        input,
        correlation,
        input.fundId,
        'PaymentDestination',
        plan.demoteDefault.id,
        plan.demoteDefault.expectedVersion,
        plan.demoteDefault.expectedVersion + 1,
      );
    }
    if (plan.changed) {
      const d = plan.configuration;
      const values = [
        input.fundId,
        d.destinationType,
        d.destinationType === 'VIETQR' ? d.bankCode : null,
        d.destinationType === 'VIETQR' ? d.accountNumber : null,
        d.destinationType === 'VIETQR' ? d.accountName : null,
        d.destinationType === 'MOMO_SANDBOX' ? d.momoPhone : null,
        d.isDefault,
        d.active,
      ];
      const from = target?.version ?? null;
      target =
        input.scope === 'CREATE_PAYMENT_DESTINATION'
          ? (
              await client.query<DestinationListRow>(
                `INSERT INTO payment_destinations
          (fund_id,destination_type,bank_code,account_number,account_name,momo_phone,is_default,active)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
                values,
              )
            ).rows[0]!
          : (
              await client.query<DestinationListRow>(
                `UPDATE payment_destinations SET
          destination_type=$2,bank_code=$3,account_number=$4,account_name=$5,momo_phone=$6,
          is_default=$7,active=$8,confirmed_by_holder_at=CASE WHEN $10 THEN NULL ELSE confirmed_by_holder_at END,
          version=version+1,updated_at=clock_timestamp() WHERE fund_id=$1 AND id=$9 RETURNING *`,
                [...values, target!.id, plan.confirmation === 'CLEAR'],
              )
            ).rows[0]!;
      await client.query(
        `UPDATE funds SET finance_version=finance_version+1,
        updated_at=clock_timestamp() WHERE id=$1`,
        [input.fundId],
      );
      await this.audit(
        client,
        input,
        correlation,
        input.fundId,
        'PaymentDestination',
        target.id,
        from,
        target.version,
      );
    }
    return { version: 1, tripId: input.tripId, destination: destinationResponse(target!, true) };
  }
  private async audit(
    client: Client,
    input: FundWrite,
    correlation: string,
    fund: string,
    entity: string,
    id: string,
    from: number | null,
    to: number,
  ) {
    await client.query(
      `INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        fund,
        input.actor,
        input.scope,
        entity,
        id,
        from,
        to,
        correlation,
        JSON.stringify({ operation_id: input.operationId }),
      ],
    );
  }
}
