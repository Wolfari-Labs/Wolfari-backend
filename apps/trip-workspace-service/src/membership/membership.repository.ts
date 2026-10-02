import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { CommonV1 } from '@wolfari/contracts/grpc';
import { randomUUID } from 'node:crypto';
import { parseEventForPublish } from '@wolfari/contracts/events';
import { fail, lockOperation, MAX_INT32, uuid, type QueryClient } from '../trip-common';
import { insertPlanUpdated } from '../planning/plan.events';
import {
  type Command,
  type Intent,
  type LifecycleRow,
  isLifecycle,
  requestHash,
  terminal,
  verifyReplay,
} from './membership.domain';

export type MemberRow = {
  id: string;
  trip_id: string;
  user_id: string;
  role: 'OWNER' | 'MEMBER';
  joined_at: Date;
  left_at: Date | null;
};
type TripRow = {
  id: string;
  archived_at: Date | null;
  deleted_at: Date | null;
  closure_lock_id: string | null;
  membership_revision: number;
  export_revision: number;
  plan_version: number;
};
@Injectable()
export class MembershipRepository {
  constructor(readonly db: DatabaseProvider) {}
  async operation(client: Pick<DatabaseProvider, 'query'>, id: string) {
    return (
      await client.query<LifecycleRow>('SELECT * FROM trip_operations WHERE operation_id=$1', [id])
    ).rows[0];
  }
  async retryNeedsReview(operationId: string, execute: boolean): Promise<LifecycleRow> {
    const id = uuid(operationId);
    return this.db.withTransaction(async (client) => {
      await lockOperation(client, id);
      const row = await this.operation(client, id);
      if (!row || !isLifecycle(row.operation_type)) return fail('RESOURCE_NOT_FOUND', 404);
      if (!execute) return row;
      await this.lockTrip(client, row.trip_id);
      if (row.state !== 'NEEDS_REVIEW') return fail('STATE_CONFLICT', 409);
      return (
        await client.query<LifecycleRow>(
          "UPDATE trip_operations SET state='PENDING_RECOVERY',retry_count=0,next_retry_at=clock_timestamp(),updated_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",
          [id],
        )
      ).rows[0]!;
    });
  }
  async lockTrip(client: QueryClient, tripId: string) {
    await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [tripId]);
    const members = (
      await client.query<MemberRow>(
        'SELECT * FROM trip_members WHERE trip_id=$1 ORDER BY id FOR UPDATE',
        [tripId],
      )
    ).rows;
    const trip = (
      await client.query<TripRow>('SELECT * FROM trips WHERE id=$1 AND deleted_at IS NULL', [
        tripId,
      ])
    ).rows[0];
    if (!trip) return fail('RESOURCE_NOT_FOUND', 404);
    return { trip, members };
  }
  actor(members: MemberRow[], actor: string, owner: boolean) {
    const member = members.find((m) => m.user_id === actor && m.left_at === null);
    if (!member) return fail('RESOURCE_NOT_FOUND', 404);
    if (owner && member.role !== 'OWNER') return fail('PERMISSION_DENIED', 403);
    return member;
  }
  async prepare(
    input: Command,
    correlation: string,
    enabled: boolean,
  ): Promise<{ row: LifecycleRow; fresh: boolean }> {
    return this.db.withTransaction(async (client) => {
      await lockOperation(client, input.operationId);
      const saved = await this.operation(client, input.operationId);
      if (saved) {
        verifyReplay(saved, input);
        if (
          !(
            await client.query('SELECT 1 FROM trips WHERE id=$1 AND deleted_at IS NULL', [
              input.tripId,
            ])
          ).rowCount
        )
          return fail('RESOURCE_NOT_FOUND', 404);
        // Leave receipts are initiator-owned historical acknowledgements, not Trip reads.
        if (input.command === 'REMOVE_MEMBER') {
          const { members } = await this.lockTrip(client, input.tripId);
          this.actor(members, input.actorUserId, true);
        }
        return { row: saved, fresh: false };
      }
      const { trip, members } = await this.lockTrip(client, input.tripId);
      const actor = this.actor(members, input.actorUserId, input.command === 'REMOVE_MEMBER');
      const target =
        input.command === 'LEAVE_MEMBER' ? actor : members.find((m) => m.id === input.memberId);
      if (!target) return fail('RESOURCE_NOT_FOUND', 404);
      if (target.role === 'OWNER' || !members.some((m) => m.role === 'OWNER' && m.left_at === null))
        return fail('STATE_CONFLICT', 409);
      if (trip.membership_revision !== input.expectedRevision)
        return fail('VERSION_CONFLICT', 409, { membership_revision: trip.membership_revision });
      if (
        target.left_at ||
        trip.archived_at ||
        trip.closure_lock_id ||
        trip.membership_revision >= MAX_INT32 ||
        trip.export_revision >= MAX_INT32 ||
        trip.plan_version >= MAX_INT32
      )
        return fail('STATE_CONFLICT', 409);
      if (
        (
          await client.query(
            "SELECT 1 FROM trip_operations WHERE trip_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY','NEEDS_REVIEW')",
            [trip.id],
          )
        ).rowCount
      )
        return fail('STATE_CONFLICT', 409);
      if (!enabled) return fail('SERVICE_UNAVAILABLE', 503);
      const intent: Intent = {
        ...input,
        version: 1,
        targetMemberId: target.id,
        targetUserId: target.user_id,
        correlationId: correlation,
        authorizationContext: {
          actor: { actor_user_id: input.actorUserId },
          trip_id: trip.id,
          context_revision: trip.membership_revision,
          active_user_ids: members.filter((m) => m.left_at === null).map((m) => m.user_id),
          command_scope: input.command,
        },
      };
      const row = (
        await client.query<LifecycleRow>(
          `INSERT INTO trip_operations(
        operation_id,trip_id,operation_type,actor_user_id,request_hash,state,context_revision,command_payload,started_at,next_retry_at)
        VALUES($1,$2,$3,$4,$5,'PROCESSING',$6,$7::jsonb,clock_timestamp(),date_trunc('milliseconds',clock_timestamp())+interval '10 seconds') RETURNING *`,
          [
            input.operationId,
            trip.id,
            input.command,
            input.actorUserId,
            requestHash(input, target.id),
            trip.membership_revision,
            JSON.stringify(intent),
          ],
        )
      ).rows[0]!;
      return { row, fresh: true };
    });
  }
  async finish(id: string, outcome: CommonV1.OperationOutcome): Promise<LifecycleRow> {
    return this.db.withTransaction(async (client) => {
      await lockOperation(client, id);
      const stored = await this.operation(client, id);
      if (!stored) throw new Error('Missing lifecycle operation');
      if (terminal(stored)) return stored;
      const { trip, members } = await this.lockTrip(client, stored.trip_id);
      if (outcome.status === CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED) {
        const intent = stored.command_payload;
        const target = members.find(
          (m) => m.id === intent.targetMemberId && m.user_id === intent.targetUserId,
        );
        if (
          !target ||
          target.left_at ||
          target.role !== 'MEMBER' ||
          trip.archived_at ||
          !members.some((m) => m.role === 'OWNER' && m.left_at === null) ||
          trip.membership_revision >= MAX_INT32 ||
          trip.export_revision >= MAX_INT32
        )
          throw new Error('Lifecycle finalization invariant');
        const editors = (
          await client.query(
            'SELECT * FROM trip_plan_editors WHERE trip_id=$1 AND trip_member_id=$2 FOR UPDATE',
            [trip.id, target.id],
          )
        ).rows;
        const packing = (
          await client.query(
            'SELECT * FROM packing_items WHERE trip_id=$1 AND assigned_member_id=$2 ORDER BY id FOR UPDATE',
            [trip.id, target.id],
          )
        ).rows;
        if (packing.length && trip.plan_version >= MAX_INT32)
          throw new Error('Plan revision exhausted');
        await client.query(
          'UPDATE trip_members SET left_at=clock_timestamp(),left_reason=$2,updated_at=clock_timestamp() WHERE id=$1',
          [target.id, stored.operation_type === 'LEAVE_MEMBER' ? 'LEFT' : 'REMOVED'],
        );
        await client.query('DELETE FROM trip_plan_editors WHERE trip_id=$1 AND trip_member_id=$2', [
          trip.id,
          target.id,
        ]);
        await client.query(
          "UPDATE packing_items SET assigned_member_id=NULL,status='TODO',completed_by_user_id=NULL,completed_at=NULL,updated_at=clock_timestamp() WHERE trip_id=$1 AND assigned_member_id=$2",
          [trip.id, target.id],
        );
        await client.query(
          'UPDATE trips SET membership_revision=membership_revision+1,export_revision=export_revision+1,plan_version=plan_version+$2,updated_at=clock_timestamp() WHERE id=$1',
          [trip.id, packing.length ? 1 : 0],
        );
        await client.query(
          `INSERT INTO trip_audit_logs(trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,reason,details,correlation_id)
          VALUES($1,$2,$3,'MEMBERSHIP',$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            trip.id,
            stored.actor_user_id,
            stored.operation_type === 'LEAVE_MEMBER' ? 'MEMBER_LEFT' : 'MEMBER_REMOVED',
            target.id,
            trip.membership_revision,
            trip.membership_revision + 1,
            intent.reason,
            JSON.stringify({
              operation_id: id,
              target_user_id: target.user_id,
              removed_editors: editors,
              packing_before: packing,
              packing_after: packing.map((p) => ({
                id: p.id,
                assigned_member_id: null,
                status: 'TODO',
                completed_by_user_id: null,
                completed_at: null,
              })),
              export_revision: [trip.export_revision, trip.export_revision + 1],
              plan_version: [trip.plan_version, trip.plan_version + (packing.length ? 1 : 0)],
            }),
            intent.correlationId,
          ],
        );
        const event = parseEventForPublish({
          event_id: randomUUID(),
          event_type: stored.operation_type === 'LEAVE_MEMBER' ? 'MemberLeft' : 'MemberRemoved',
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'Trip',
          aggregate_type: 'Membership',
          aggregate_id: target.id,
          aggregate_version: trip.membership_revision + 1,
          correlation_id: intent.correlationId,
          causation_id: null,
          operation_id: id,
          trip_id: trip.id,
          actor_user_id: stored.actor_user_id,
          system_actor: null,
          payload: {
            trip_id: trip.id,
            user_id: target.user_id,
            membership_revision: trip.membership_revision + 1,
          },
        });
        await client.query(
          `INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,occurred_at,actor_user_id,trip_id,operation_id)
          VALUES($1,$2,1,$3,$4,$5,$6::jsonb,'Membership','Trip',$7,$8,$9,$10)`,
          [
            event.event_id,
            event.event_type,
            target.id,
            event.aggregate_version,
            intent.correlationId,
            JSON.stringify(event.payload),
            event.occurred_at,
            stored.actor_user_id,
            trip.id,
            id,
          ],
        );
        if (packing.length)
          await insertPlanUpdated(client, {
            tripId: trip.id,
            actorUserId: stored.actor_user_id,
            operationId: id,
            correlationId: intent.correlationId,
            planVersion: trip.plan_version + 1,
            changes: packing.map((p) => ({
              type: 'PACKING_ITEM',
              id: String(p.id),
              action: 'UPSERT',
            })),
          });
      }
      return (
        await client.query<LifecycleRow>(
          `UPDATE trip_operations SET state=$2,outcome=$3::jsonb,completed_at=clock_timestamp(),updated_at=clock_timestamp(),next_retry_at=NULL WHERE operation_id=$1 RETURNING *`,
          [
            id,
            outcome.status === CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED
              ? 'SUCCEEDED'
              : 'FAILED',
            JSON.stringify(outcome),
          ],
        )
      ).rows[0]!;
    });
  }
}
