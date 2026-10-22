import { Inject, Injectable } from '@nestjs/common';
import type { CommonV1, FinanceV1 } from '@wolfari/contracts/grpc';
import { DatabaseProvider } from '@wolfari/database';
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
  async execute(request: FinanceV1.ExecuteTripOperationRequest): Promise<CommonV1.Receipt> {
    const input = this.parse(request, request.operation_type ?? '');
    return this.db.withTransaction(async (client) => {
      await this.lock(client, input.operationId);
      const saved = await this.find(client, input.operationId);
      if (saved) {
        this.verify(saved, input);
        return receiptView(saved);
      }
      const fund = (
        await client.query<{ id: string }>('SELECT id FROM funds WHERE trip_id=$1 FOR UPDATE', [
          input.tripId,
        ])
      ).rows[0];
      let blocked = false;
      if (fund) {
        blocked = Boolean(
          (
            await client.query(
              `SELECT 1 FROM contributions c
               JOIN payment_attempts p ON p.contribution_id=c.id
               LEFT JOIN fund_transactions t ON t.contribution_id=c.id
                 AND t.transaction_type='CONTRIBUTION'
               WHERE c.fund_id=$1 AND c.member_user_id=$2 AND (
                 p.status IN ('CREATED','PENDING') OR p.needs_reconciliation OR
                 (p.status='SUCCEEDED' AND (c.status<>'CONFIRMED' OR t.id IS NULL)) OR
                 EXISTS (SELECT 1 FROM payment_webhook_receipts w
                   WHERE w.payment_attempt_id=p.id
                     AND w.processing_status IN ('RECEIVED','NEEDS_REVIEW'))
               ) LIMIT 1`,
              [fund.id, input.targetUserId],
            )
          ).rowCount,
        );
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
