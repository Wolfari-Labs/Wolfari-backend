import { Inject, Injectable } from '@nestjs/common';
import type { CommonV1, FinanceV1 } from '@wolfari/contracts/grpc';
import { DatabaseProvider } from '@wolfari/database';
import { randomUUID } from 'node:crypto';
import { planMembershipLifecycle } from '../domain/membership-lifecycle';
import { FinanceReadError, readUuid } from '../finance.errors';
import {
  lifecycleCommandScope,
  receiptView,
  type FundReceipt,
  type StoredResult,
} from './fund-command.repository';

type LifecycleIntent = Readonly<{
  operationId: string;
  actor: string;
  tripId: string;
  targetMembershipId: string;
  targetUserId: string;
  scope: 'LEAVE_MEMBER' | 'REMOVE_MEMBER';
  hash: string;
}>;
type Client = Pick<DatabaseProvider, 'query'>;
type FundRow = {
  id: string;
  holder_user_id: string;
  status: string;
  finance_version: number;
};
type ContributionRow = { id: string; status: string; version: number };
type AttemptRow = {
  id: string;
  contribution_id: string;
  status: string;
  needs_reconciliation: boolean;
};
type WebhookRow = { payment_attempt_id: string; processing_status: string };
type RefundRow = { status: string; reversal_requested_at: Date | null };
type ContributionLedgerRow = { id: string; contribution_id: string };

@Injectable()
export class LifecycleFinanceRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: DatabaseProvider) {}

  private parse(
    input: FinanceV1.ExecuteTripOperationRequest | FinanceV1.CancelOperationIfNotCommittedRequest,
    scope: string,
  ): LifecycleIntent {
    const context = input.authorization_context;
    const target = input.membership_target;
    const operationId = readUuid(input.operation_id);
    if (
      !context ||
      !target ||
      !lifecycleCommandScope(scope) ||
      context.command_scope !== scope ||
      context.actor?.system_actor !== undefined ||
      !/^[a-f0-9]{64}$/.test(input.request_hash ?? '') ||
      !Number.isInteger(context.context_revision) ||
      Number(context.context_revision) < 1 ||
      typeof target.reason !== 'string' ||
      !target.reason.trim() ||
      target.reason.includes('\u0000') ||
      [...target.reason.trim()].length > 1000
    )
      throw new FinanceReadError('VALIDATION_FAILED');
    const actor = readUuid(context.actor?.actor_user_id);
    const tripId = readUuid(context.trip_id);
    const targetMembershipId = readUuid(target.membership_id);
    const targetUserId = readUuid(target.user_id);
    const active = context.active_user_ids?.map(readUuid) ?? [];
    if (
      !active.includes(actor) ||
      !active.includes(targetUserId) ||
      new Set(active).size !== active.length ||
      (scope === 'LEAVE_MEMBER' && actor !== targetUserId)
    )
      throw new FinanceReadError('VALIDATION_FAILED');
    return {
      operationId,
      actor,
      tripId,
      targetMembershipId,
      targetUserId,
      scope: scope as LifecycleIntent['scope'],
      hash: input.request_hash!,
    };
  }
  private async lock(client: Client, id: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
  }
  private async find(client: Client, id: string) {
    return (
      await client.query<FundReceipt>('SELECT * FROM command_receipts WHERE operation_id=$1', [id])
    ).rows[0];
  }
  private verify(row: FundReceipt, input: LifecycleIntent) {
    if (row.actor_user_id !== input.actor) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    if (
      row.command_scope !== input.scope ||
      row.request_hash !== input.hash ||
      row.response?.version !== 1 ||
      row.response.tripId !== input.tripId ||
      row.response.lifecycleTarget?.membershipId !== input.targetMembershipId ||
      row.response.lifecycleTarget.userId !== input.targetUserId
    )
      throw new FinanceReadError('IDEMPOTENCY_CONFLICT');
  }
  private async save(
    client: Client,
    input: LifecycleIntent,
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
  async execute(
    request: FinanceV1.ExecuteTripOperationRequest,
    correlation: string,
  ): Promise<CommonV1.Receipt> {
    const input = this.parse(request, request.operation_type ?? '');
    return this.db.withTransaction(async (client) => {
      await this.lock(client, input.operationId);
      const saved = await this.find(client, input.operationId);
      if (saved) {
        this.verify(saved, input);
        return receiptView(saved);
      }
      const fund = (
        await client.query<FundRow>(
          'SELECT id,holder_user_id,status,finance_version FROM funds WHERE trip_id=$1 FOR UPDATE',
          [input.tripId],
        )
      ).rows[0];
      let blocked = false;
      if (fund) {
        const closures = await client.query<{ id: string }>(
          `SELECT id FROM finance_closures
           WHERE fund_id=$1 AND status='PENDING_CONFIRMATIONS' ORDER BY id FOR UPDATE`,
          [fund.id],
        );
        const contributions = (
          await client.query<ContributionRow>(
            `SELECT id,status,version FROM contributions
             WHERE fund_id=$1 AND member_user_id=$2 ORDER BY id FOR UPDATE`,
            [fund.id, input.targetUserId],
          )
        ).rows;
        const contributionIds = contributions.map((row) => row.id);
        const attempts = (
          await client.query<AttemptRow>(
            `SELECT id,contribution_id,status,needs_reconciliation FROM payment_attempts
             WHERE contribution_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [contributionIds],
          )
        ).rows;
        const attemptIds = attempts.map((row) => row.id);
        const webhooks = (
          await client.query<WebhookRow>(
            `SELECT payment_attempt_id,processing_status FROM payment_webhook_receipts
             WHERE payment_attempt_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [attemptIds],
          )
        ).rows;
        const originalLedgers = (
          await client.query<ContributionLedgerRow>(
            `SELECT id,contribution_id FROM fund_transactions
               WHERE fund_id=$1 AND contribution_id=ANY($2::uuid[])
                 AND transaction_type='CONTRIBUTION'`,
            [fund.id, contributionIds],
          )
        ).rows;
        const ledgerContributionIds = new Set(originalLedgers.map((row) => row.contribution_id));
        const reversedLedgerIds = new Set(
          (
            await client.query<{ reversal_of_id: string }>(
              `SELECT reversal_of_id FROM fund_transactions
               WHERE fund_id=$1 AND reversal_of_id=ANY($2::uuid[])
                 AND transaction_type='REVERSAL'`,
              [fund.id, originalLedgers.map((row) => row.id)],
            )
          ).rows.map((row) => row.reversal_of_id),
        );
        const refunds = (
          await client.query<RefundRow>(
            `SELECT status,reversal_requested_at FROM fund_refunds
             WHERE fund_id=$1 AND member_user_id=$2 ORDER BY id FOR UPDATE`,
            [fund.id, input.targetUserId],
          )
        ).rows;
        const contributionById = new Map(contributions.map((row) => [row.id, row]));
        const hasBlockingPayment =
          attempts.some((attempt) => {
            const contribution = contributionById.get(attempt.contribution_id)!;
            return (
              attempt.needs_reconciliation ||
              ['CREATED', 'PENDING'].includes(attempt.status) ||
              (attempt.status === 'SUCCEEDED' &&
                (!['CONFIRMED', 'REVERSED'].includes(contribution.status) ||
                  !ledgerContributionIds.has(contribution.id)))
            );
          }) ||
          webhooks.some((row) => ['RECEIVED', 'NEEDS_REVIEW'].includes(row.processing_status));
        const hasInconsistentLedger = contributions.some((row) => {
          const original = originalLedgers.find((ledger) => ledger.contribution_id === row.id);
          const hasReversal = Boolean(original && reversedLedgerIds.has(original.id));
          if (row.status === 'CONFIRMED') return !original || hasReversal;
          if (row.status === 'REVERSED') return !original || !hasReversal;
          return Boolean(original);
        });
        const plan = planMembershipLifecycle({
          fundStatus: fund.status,
          targetIsHolder: fund.holder_user_id === input.targetUserId,
          closurePending: Boolean(closures.rowCount),
          hasTransferReported: contributions.some((row) => row.status === 'TRANSFER_REPORTED'),
          hasBlockingPayment,
          hasBlockingRefund: refunds.some(
            (row) =>
              ['PENDING', 'HOLDER_REPORTED'].includes(row.status) ||
              (row.status === 'CONFIRMED' && row.reversal_requested_at !== null),
          ),
          hasInconsistentLedger,
          financeVersion: fund.finance_version,
          pendingContributionVersions: contributions
            .filter((row) => row.status === 'PENDING')
            .map((row) => row.version),
        });
        blocked = plan.blocked;
        if (plan.waivePending) {
          const pending = contributions.filter((row) => row.status === 'PENDING');
          const waived = (
            await client.query<{ id: string; version: number }>(
              `UPDATE contributions SET status='WAIVED',waived_reason='MEMBER_LEFT',
                 waived_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
               WHERE id=ANY($1::uuid[]) AND fund_id=$2 AND status='PENDING'
               RETURNING id,version`,
              [pending.map((row) => row.id), fund.id],
            )
          ).rows;
          if (waived.length !== pending.length) throw new Error('Lifecycle contribution race');
          const advanced = await client.query(
            `UPDATE funds SET finance_version=$2,updated_at=clock_timestamp()
             WHERE id=$1 AND finance_version=$3`,
            [fund.id, plan.financeVersion, fund.finance_version],
          );
          if (advanced.rowCount !== 1) throw new Error('Lifecycle Fund version race');
          const previousVersions = new Map(pending.map((row) => [row.id, row.version]));
          for (const row of waived) {
            await client.query(
              `INSERT INTO finance_audit_logs
               (fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,
                correlation_id,reason,details)
               VALUES($1,$2,$3,'Contribution',$4,$5,$6,$7,'MEMBER_LEFT',$8::jsonb)`,
              [
                fund.id,
                input.actor,
                input.scope,
                row.id,
                previousVersions.get(row.id),
                row.version,
                correlation,
                JSON.stringify({
                  operation_id: input.operationId,
                  membership_id: input.targetMembershipId,
                  finance_version: plan.financeVersion,
                }),
              ],
            );
            await client.query(
              `INSERT INTO outbox_events
               (event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,
                payload,aggregate_type,producer,operation_id,trip_id,actor_user_id)
               VALUES($1,'ContributionUpdated',1,$2,$3,$4,$5::jsonb,'Fund','Finance',$6,$7,$8)`,
              [
                randomUUID(),
                fund.id,
                plan.financeVersion,
                correlation,
                JSON.stringify({
                  fund_id: fund.id,
                  trip_id: input.tripId,
                  contribution_id: row.id,
                  status: 'WAIVED',
                  finance_version: plan.financeVersion,
                }),
                input.operationId,
                input.tripId,
                input.actor,
              ],
            );
          }
        }
      }
      const row = await this.save(client, input, blocked ? 'REJECTED' : 'COMMITTED', {
        version: 1,
        tripId: input.tripId,
        lifecycleTarget: {
          membershipId: input.targetMembershipId,
          userId: input.targetUserId,
        },
        ...(blocked ? { error: 'FINANCE_OBLIGATION_BLOCKED' as const } : {}),
      });
      return receiptView(row);
    });
  }
  async cancel(request: FinanceV1.CancelOperationIfNotCommittedRequest): Promise<CommonV1.Receipt> {
    const input = this.parse(request, request.command_scope ?? '');
    return this.db.withTransaction(async (client) => {
      await this.lock(client, input.operationId);
      const saved = await this.find(client, input.operationId);
      if (saved) {
        this.verify(saved, input);
        return receiptView(saved);
      }
      return receiptView(
        await this.save(client, input, 'CANCELLED', {
          version: 1,
          tripId: input.tripId,
          lifecycleTarget: {
            membershipId: input.targetMembershipId,
            userId: input.targetUserId,
          },
          error: 'STATE_CONFLICT',
        }),
      );
    });
  }
}
