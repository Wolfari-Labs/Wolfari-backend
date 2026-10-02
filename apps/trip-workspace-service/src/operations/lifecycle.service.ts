import { Injectable, Logger, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommonV1, TripV1 } from '@wolfari/contracts/grpc';
import { fail, instant, lockOperation, uuid } from '../trip-common';
import { protobufTimestamp } from '../grpc-common';
import { MembershipRepository, type MemberRow } from '../membership/membership.repository';
import {
  command,
  isLifecycle,
  operationView,
  retryDelays,
  terminal,
  validateReceipt,
  type LifecycleCommand,
  type LifecycleRow,
} from '../membership/membership.domain';
import { LifecycleFinanceClient } from './lifecycle-finance.client';

@Injectable()
export class LifecycleService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('MembershipLifecycle');
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly enabled: boolean;
  constructor(
    private readonly repo: MembershipRepository,
    private readonly finance: LifecycleFinanceClient,
    config: ConfigService,
  ) {
    const flag = config.get<string>('TRIP_MEMBERSHIP_LIFECYCLE_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(flag)) throw new Error('Invalid lifecycle flag');
    this.enabled = flag === 'true';
  }
  onModuleInit() {
    // Disabling new writes must NEVER disable recovery of accepted intents.
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.recoverDue()
          .catch(() => {
            this.logger.warn('LIFECYCLE_RECOVERY_UNAVAILABLE');
          })
          .finally(() => {
            this.running = undefined;
          });
    }, 1000);
    this.timer.unref();
  }
  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }
  async execute(
    input: Record<string, unknown>,
    kind: LifecycleCommand,
    correlation: string,
    deadline: number,
  ): Promise<CommonV1.Operation> {
    const prepared = await this.repo.prepare(command(input, kind), uuid(correlation), this.enabled);
    let row = prepared.row;
    if (prepared.fresh) {
      try {
        const receipt = await this.finance.execute(row, deadline);
        row = await this.repo.finish(row.operation_id, validateReceipt(row, receipt));
      } catch {
        await this.defer(row);
        row = (await this.repo.operation(this.repo.db, row.operation_id))!;
      }
    }
    if (row.state === 'FAILED')
      return fail(
        row.outcome?.error_code === 'FINANCE_OBLIGATION_BLOCKED'
          ? 'FINANCE_OBLIGATION_BLOCKED'
          : row.outcome?.error_code === 'VERSION_CONFLICT'
            ? 'VERSION_CONFLICT'
            : 'STATE_CONFLICT',
        409,
      );
    return operationView(row);
  }
  async getOperation(operationId: unknown, actorId: unknown) {
    const actor = uuid(actorId);
    const row = await this.repo.operation(this.repo.db, uuid(operationId));
    if (!row || row.actor_user_id !== actor || !isLifecycle(row.operation_type))
      return fail('RESOURCE_NOT_FOUND', 404);
    return operationView(row);
  }
  private async defer(row: LifecycleRow) {
    const state = row.retry_count >= retryDelays.length ? 'NEEDS_REVIEW' : 'PENDING_RECOVERY';
    await this.repo.db.query(
      `UPDATE trip_operations SET state=$2::varchar,updated_at=clock_timestamp(),
      next_retry_at=CASE WHEN $2::varchar='NEEDS_REVIEW' THEN NULL ELSE date_trunc('milliseconds',clock_timestamp())+($3::int * interval '1 second') END
      WHERE operation_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY') AND retry_count=$4 AND next_retry_at IS NOT DISTINCT FROM $5`,
      [
        row.operation_id,
        state,
        retryDelays[row.retry_count] ?? 900,
        row.retry_count,
        row.next_retry_at,
      ],
    );
    this.logger.warn(`LIFECYCLE_${state} operation_id=${row.operation_id}`);
  }
  async recoverDue() {
    const candidates = (
      await this.repo.db.query<{ operation_id: string }>(`SELECT operation_id FROM trip_operations
      WHERE operation_type IN ('LEAVE_MEMBER','REMOVE_MEMBER') AND state IN ('PROCESSING','PENDING_RECOVERY')
      AND next_retry_at<=clock_timestamp() ORDER BY next_retry_at,operation_id LIMIT 20`)
    ).rows;
    for (const candidate of candidates) {
      const claimed = await this.repo.db.withTransaction(async (client) => {
        const lock = (
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
            [candidate.operation_id],
          )
        ).rows[0];
        if (!lock?.locked) return undefined;
        const original = await this.repo.operation(client, candidate.operation_id);
        if (!original || terminal(original)) return undefined;
        // Claim is internal recovery, not a new Trip read. Even a corrupt/deleted
        // Trip must consume bounded attempts and reach NEEDS_REVIEW, not starve
        // every other due operation. Finalize still checks all business invariants.
        await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [original.trip_id]);
        await client.query('SELECT id FROM trip_members WHERE trip_id=$1 ORDER BY id FOR UPDATE', [
          original.trip_id,
        ]);
        if (original.retry_count >= retryDelays.length) {
          await client.query(
            "UPDATE trip_operations SET state='NEEDS_REVIEW',next_retry_at=NULL,updated_at=clock_timestamp() WHERE operation_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY') AND next_retry_at<=clock_timestamp()",
            [original.operation_id],
          );
          return undefined;
        }
        return (
          await client.query<LifecycleRow>(
            `UPDATE trip_operations SET retry_count=retry_count+1,
          state='PENDING_RECOVERY',next_retry_at=date_trunc('milliseconds',clock_timestamp())+interval '15 seconds',updated_at=clock_timestamp()
          WHERE operation_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY') AND next_retry_at<=clock_timestamp() RETURNING *`,
            [candidate.operation_id],
          )
        ).rows[0];
      });
      if (!claimed) continue;
      try {
        await this.repo.finish(
          claimed.operation_id,
          validateReceipt(claimed, await this.finance.recover(claimed, Date.now() + 6000)),
        );
      } catch {
        await this.defer(claimed);
      }
    }
  }
  async list(input: TripV1.ListMembersRequest): Promise<TripV1.ListMembersResponse> {
    const tripId = uuid(input.trip_id),
      actorId = uuid(input.actor_user_id);
    const limit = input.limit ?? 20,
      includeLeft = input.include_left ?? false;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof includeLeft !== 'boolean')
      return fail('VALIDATION_FAILED', 400);
    let after: { joined: string; id: string } | undefined;
    if (input.cursor) {
      try {
        if (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (
          value.version !== 1 ||
          value.trip !== tripId ||
          value.includeLeft !== includeLeft ||
          typeof value.joined !== 'string'
        )
          throw new Error();
        instant(value.joined);
        after = { joined: value.joined, id: uuid(value.id) };
      } catch {
        return fail('VALIDATION_FAILED', 400);
      }
    }
    return this.repo.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const actor = await client.query(
        'SELECT 1 FROM trips t JOIN trip_members m ON m.trip_id=t.id WHERE t.id=$1 AND t.deleted_at IS NULL AND m.user_id=$2 AND m.left_at IS NULL',
        [tripId, actorId],
      );
      if (!actor.rowCount) return fail('RESOURCE_NOT_FOUND', 404);
      const rows = (
        await client.query<MemberRow & { cursor_joined: string }>(
          `SELECT *,to_char(joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_joined
        FROM trip_members WHERE trip_id=$1 AND ($2 OR left_at IS NULL)
        AND ($3::timestamptz IS NULL OR (joined_at,id)>($3::timestamptz,$4::uuid)) ORDER BY joined_at,id LIMIT $5`,
          [tripId, includeLeft, after?.joined ?? null, after?.id ?? null, limit + 1],
        )
      ).rows;
      const page = rows.slice(0, limit),
        last = page.at(-1);
      return {
        items: page.map((m) => ({
          id: m.id,
          trip_id: m.trip_id,
          user_id: m.user_id,
          role:
            m.role === 'OWNER'
              ? CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER
              : CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
          joined_at: protobufTimestamp(m.joined_at.toISOString()),
          left_at: m.left_at ? protobufTimestamp(m.left_at.toISOString()) : undefined,
        })),
        next_cursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  trip: tripId,
                  includeLeft,
                  joined: last.cursor_joined,
                  id: last.id,
                }),
              ).toString('base64url')
            : undefined,
      };
    });
  }
  async retryNeedsReview(operationId: string, execute: boolean) {
    return this.repo.db.withTransaction(async (client) => {
      await lockOperation(client, uuid(operationId));
      const row = await this.repo.operation(client, operationId);
      if (!row || !isLifecycle(row.operation_type)) return fail('RESOURCE_NOT_FOUND', 404);
      if (!execute) return operationView(row);
      await this.repo.lockTrip(client, row.trip_id);
      if (row.state !== 'NEEDS_REVIEW') return fail('STATE_CONFLICT', 409);
      const updated = (
        await client.query<LifecycleRow>(
          "UPDATE trip_operations SET state='PENDING_RECOVERY',retry_count=0,next_retry_at=clock_timestamp(),updated_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",
          [operationId],
        )
      ).rows[0]!;
      this.logger.log(`LIFECYCLE_MANUAL_RETRY operation_id=${operationId}`);
      return operationView(updated);
    });
  }
}
