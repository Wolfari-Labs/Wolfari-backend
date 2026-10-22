import { Injectable, Logger, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import { CommonV1, TripV1 } from '@wolfari/contracts/grpc';
import { MembershipRepository } from '../membership/membership.repository';
import { states, retryDelays } from '../membership/membership.domain';
import { fail, lockOperation, uuid } from '../trip-common';
import type { DatabaseProvider } from '@wolfari/database';
import { protobufTimestamp } from '../grpc-common';
import { LifecycleFinanceClient } from './lifecycle-finance.client';

const FUND_COMMANDS = [
  'REPORT_TRANSFER',
  'CONFIRM_RECEIVED',
  'REJECT_TRANSFER',
  'REVERSE_CONTRIBUTION',
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
];
export const isFundCommand = (value: string) => FUND_COMMANDS.includes(value);
type Intent = {
  version: 1;
  correlation: string;
  context: CommonV1.AuthorizationContext;
  ownerUserId: string;
};
export type FundOperationRow = {
  operation_id: string;
  trip_id: string;
  actor_user_id: string;
  operation_type: string;
  request_hash: string;
  state: keyof typeof states;
  command_payload: Intent;
  outcome: CommonV1.OperationOutcome | null;
  retry_count: number;
  next_retry_at: Date | null;
};
const terminal = (row: FundOperationRow) => ['SUCCEEDED', 'FAILED'].includes(row.state);
export function fundOperationView(row: FundOperationRow): CommonV1.Operation {
  if (!isFundCommand(row.operation_type) || !(row.state in states))
    throw new Error('Invalid operation');
  return {
    operation_id: row.operation_id,
    trip_id: row.trip_id,
    state: states[row.state],
    outcome: row.outcome
      ? {
          status: row.outcome.status,
          blocking_ids: [],
          error_code: row.outcome.error_code,
        }
      : undefined,
    error_code: row.outcome?.error_code,
    next_retry_at: row.next_retry_at
      ? protobufTimestamp(row.next_retry_at.toISOString())
      : undefined,
  };
}
function outcome(value: CommonV1.OperationOutcome | undefined): CommonV1.OperationOutcome {
  if (
    !value ||
    ![1, 2, 3].includes(value.status ?? 0) ||
    value.closure_effect ||
    (value.blocking_ids?.length ?? 0) > 0 ||
    (value.error_code && !['STATE_CONFLICT', 'VERSION_CONFLICT'].includes(value.error_code)) ||
    (value.status === 1 && value.error_code)
  )
    return fail('VALIDATION_FAILED', 400);
  return {
    status: value.status,
    blocking_ids: [],
    error_code: value.status === 1 ? undefined : (value.error_code ?? 'STATE_CONFLICT'),
  };
}

/** Finance-origin commands only. Never calls the membership departure finalizer. */
@Injectable()
export class FinanceOperationService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('FinanceOperationRecovery');
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly repo: MembershipRepository,
    private readonly finance: LifecycleFinanceClient,
  ) {}
  private async row(client: Pick<DatabaseProvider, 'query'>, id: string) {
    return (
      await client.query<FundOperationRow>('SELECT * FROM trip_operations WHERE operation_id=$1', [
        id,
      ])
    ).rows[0];
  }
  async begin(
    input: TripV1.BeginFinanceOperationRequest,
    correlation: string,
  ): Promise<TripV1.BeginFinanceOperationResponse> {
    const id = uuid(input.operation_id),
      tripId = uuid(input.trip_id),
      actor = uuid(input.actor?.actor_user_id);
    if (
      input.actor?.system_actor !== undefined ||
      !isFundCommand(input.command ?? '') ||
      !/^[a-f0-9]{64}$/.test(input.request_hash ?? '') ||
      (input.expected_context_revision !== undefined &&
        (!Number.isInteger(input.expected_context_revision) || input.expected_context_revision < 1))
    )
      return fail('VALIDATION_FAILED', 400);
    return this.repo.db.withTransaction(async (client) => {
      await lockOperation(client, id);
      const saved = await this.row(client, id);
      if (saved) {
        if (saved.actor_user_id !== actor) return fail('RESOURCE_NOT_FOUND', 404);
        if (
          saved.trip_id !== tripId ||
          saved.operation_type !== input.command ||
          saved.request_hash !== input.request_hash ||
          saved.command_payload?.version !== 1
        )
          return fail('IDEMPOTENCY_CONFLICT', 409);
        // Historical authorization is valid ONLY for finishing this exact intent.
        // Finance serializes execute/cancel and rechecks read permission on replay.
        return {
          context: saved.command_payload.context,
          active_user_ids: saved.command_payload.context.active_user_ids,
          owner_user_id: saved.command_payload.ownerUserId,
        };
      }
      const { trip, members } = await this.repo.lockTrip(client, tripId);
      this.repo.actor(
        members,
        actor,
        ![
          'CONFIRM_PAYMENT_DESTINATION',
          'REPORT_TRANSFER',
          'CONFIRM_RECEIVED',
          'REJECT_TRANSFER',
          'REVERSE_CONTRIBUTION',
        ].includes(input.command!),
      );
      if (trip.archived_at || trip.closure_lock_id) return fail('STATE_CONFLICT', 409);
      if (
        input.expected_context_revision !== undefined &&
        input.expected_context_revision !== trip.membership_revision
      )
        return fail('VERSION_CONFLICT', 409);
      if (
        (
          await client.query(
            "SELECT 1 FROM trip_operations WHERE trip_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY','NEEDS_REVIEW')",
            [tripId],
          )
        ).rowCount
      )
        return fail('STATE_CONFLICT', 409);
      const active = members.filter((m) => m.left_at === null);
      const owners = active.filter((m) => m.role === 'OWNER');
      if (owners.length !== 1) return fail('STATE_CONFLICT', 409);
      const context: CommonV1.AuthorizationContext = {
        actor: { actor_user_id: actor },
        trip_id: tripId,
        context_revision: trip.membership_revision,
        active_user_ids: active.map((m) => m.user_id),
        command_scope: input.command,
      };
      const intent: Intent = {
        version: 1,
        correlation: uuid(correlation),
        context,
        ownerUserId: owners[0]!.user_id,
      };
      await client.query(
        `INSERT INTO trip_operations
        (operation_id,trip_id,operation_type,actor_user_id,request_hash,state,context_revision,command_payload,started_at,next_retry_at)
        VALUES($1,$2,$3,$4,$5,'PROCESSING',$6,$7::jsonb,clock_timestamp(),clock_timestamp()+interval '10 seconds')`,
        [
          id,
          tripId,
          input.command,
          actor,
          input.request_hash,
          trip.membership_revision,
          JSON.stringify(intent),
        ],
      );
      return {
        context,
        active_user_ids: context.active_user_ids,
        owner_user_id: intent.ownerUserId,
      };
    });
  }
  async complete(input: TripV1.CompleteOperationRequest): Promise<CommonV1.Operation> {
    const id = uuid(input.operation_id),
      actor = uuid(input.actor?.actor_user_id);
    if (
      input.actor?.system_actor !== undefined ||
      input.closure_effect ||
      !/^[a-f0-9]{64}$/.test(input.request_hash ?? '')
    )
      return fail('VALIDATION_FAILED', 400);
    const result = outcome(input.finance_outcome);
    return this.repo.db.withTransaction(async (client) => {
      await lockOperation(client, id);
      const row = await this.row(client, id);
      if (!row || row.actor_user_id !== actor || !isFundCommand(row.operation_type))
        return fail('RESOURCE_NOT_FOUND', 404);
      if (row.request_hash !== input.request_hash) return fail('IDEMPOTENCY_CONFLICT', 409);
      if (terminal(row)) {
        if (JSON.stringify(outcome(row.outcome ?? undefined)) !== JSON.stringify(result))
          return fail('STATE_CONFLICT', 409);
        return fundOperationView(row);
      }
      await this.repo.lockTrip(client, row.trip_id);
      const updated = (
        await client.query<FundOperationRow>(
          `UPDATE trip_operations SET state=$2,
        outcome=$3::jsonb,completed_at=clock_timestamp(),updated_at=clock_timestamp(),next_retry_at=NULL
        WHERE operation_id=$1 RETURNING *`,
          [id, result.status === 1 ? 'SUCCEEDED' : 'FAILED', JSON.stringify(result)],
        )
      ).rows[0]!;
      return fundOperationView(updated);
    });
  }
  async getOperation(id: unknown, actor: unknown): Promise<CommonV1.Operation | undefined> {
    const row = await this.row(this.repo.db, uuid(id));
    if (!row || !isFundCommand(row.operation_type)) return undefined;
    if (row.actor_user_id !== uuid(actor)) return fail('RESOURCE_NOT_FOUND', 404);
    return fundOperationView(row);
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      this.running ??= this.recoverDue()
        .catch(() => {
          this.logger.warn('FINANCE_RECOVERY_UNAVAILABLE');
        })
        .finally(() => {
          this.running = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  /** Operator CLI only. Scheduling a retry never releases a guard or changes a receipt. */
  async retryNeedsReview(operationId: string, execute: boolean) {
    const id = uuid(operationId);
    return this.repo.db.withTransaction(async (client) => {
      await lockOperation(client, id);
      const row = await this.row(client, id);
      if (!row || !isFundCommand(row.operation_type)) return fail('RESOURCE_NOT_FOUND', 404);
      if (!execute) return fundOperationView(row);
      if (row.state !== 'NEEDS_REVIEW') return fail('STATE_CONFLICT', 409);
      await this.repo.lockTrip(client, row.trip_id);
      return fundOperationView(
        (
          await client.query<FundOperationRow>(
            `UPDATE trip_operations
        SET state='PENDING_RECOVERY',retry_count=0,next_retry_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE operation_id=$1 RETURNING *`,
            [id],
          )
        ).rows[0]!,
      );
    });
  }
  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }
  async recoverDue() {
    const candidates = (
      await this.repo.db.query<{ operation_id: string }>(`SELECT operation_id FROM trip_operations
      WHERE operation_type IN ('ENABLE_FUND','CONFIRM_PAYMENT_DESTINATION',
        'UPDATE_FUND_BUDGET','CREATE_PAYMENT_DESTINATION','UPDATE_PAYMENT_DESTINATION','CREATE_CONTRIBUTION_REQUEST',
        'UPDATE_CONTRIBUTION_REQUEST','UPDATE_CONTRIBUTION_AMOUNT','WAIVE_CONTRIBUTION','CANCEL_CONTRIBUTION',
        'REPORT_TRANSFER','CONFIRM_RECEIVED','REJECT_TRANSFER','REVERSE_CONTRIBUTION')
      AND state IN ('PROCESSING','PENDING_RECOVERY') AND next_retry_at<=clock_timestamp()
      ORDER BY next_retry_at,operation_id LIMIT 20`)
    ).rows;
    for (const candidate of candidates) {
      const row = await this.repo.db.withTransaction(async (client) => {
        const locked = (
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
            [candidate.operation_id],
          )
        ).rows[0]?.locked;
        if (!locked) return undefined;
        const saved = await this.row(client, candidate.operation_id);
        if (!saved || terminal(saved) || !isFundCommand(saved.operation_type)) return undefined;
        // A short claim; RPC is always after commit. Duplicate workers remain safe via terminal receipts.
        if (saved.retry_count >= retryDelays.length) {
          await client.query(
            "UPDATE trip_operations SET state='NEEDS_REVIEW',next_retry_at=NULL,updated_at=clock_timestamp() WHERE operation_id=$1 AND next_retry_at<=clock_timestamp()",
            [saved.operation_id],
          );
          return undefined;
        }
        return (
          await client.query<FundOperationRow>(
            `UPDATE trip_operations SET retry_count=retry_count+1,
          state='PENDING_RECOVERY',next_retry_at=date_trunc('milliseconds',clock_timestamp())+interval '15 seconds',updated_at=clock_timestamp()
          WHERE operation_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY') AND next_retry_at<=clock_timestamp() RETURNING *`,
            [saved.operation_id],
          )
        ).rows[0];
      });
      if (!row) continue;
      try {
        const receipt = await this.finance.recoverOperation(
          row.operation_id,
          row.request_hash,
          row.operation_type,
          row.command_payload.context,
          row.command_payload.correlation,
          Date.now() + 6000,
        );
        if (
          receipt.operation_id !== row.operation_id ||
          receipt.request_hash !== row.request_hash ||
          !receipt.completed_at
        )
          throw new Error('Invalid Finance receipt');
        await this.complete({
          operation_id: row.operation_id,
          actor: { actor_user_id: row.actor_user_id },
          request_hash: row.request_hash,
          finance_outcome: receipt.outcome,
        });
      } catch {
        await this.repo.db.query(
          `UPDATE trip_operations SET state=$2::varchar,next_retry_at=CASE WHEN $2::varchar='NEEDS_REVIEW' THEN NULL
          ELSE clock_timestamp()+($3::int * interval '1 second') END,updated_at=clock_timestamp()
          WHERE operation_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY') AND retry_count=$4 AND next_retry_at=$5`,
          [
            row.operation_id,
            row.retry_count >= retryDelays.length ? 'NEEDS_REVIEW' : 'PENDING_RECOVERY',
            retryDelays[row.retry_count] ?? 900,
            row.retry_count,
            row.next_retry_at,
          ],
        );
      }
    }
  }
}
