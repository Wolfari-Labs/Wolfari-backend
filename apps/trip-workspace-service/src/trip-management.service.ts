import { MemberProfilesService } from './membership/member-profiles.service';
import { Injectable } from '@nestjs/common';
import { CommonV1, type TripV1 } from '@wolfari/contracts/grpc';
import { randomUUID } from 'node:crypto';
import { parseEventForPublish } from '@wolfari/contracts/events';
import { MembershipRepository } from './membership/membership.repository';
import { LifecycleFinanceClient } from './operations/lifecycle-finance.client';
import {
  digest,
  fail,
  insertReceipt,
  lockOperation,
  MAX_INT32,
  positiveRevision,
  receiptById,
  uuid,
  verifyReceipt,
} from './trip-common';
import { protobufTimestamp } from './grpc-common';

@Injectable()
export class TripManagementService {
  constructor(
    private readonly repo: MembershipRepository,
    private readonly finance: LifecycleFinanceClient,
    private readonly profiles: MemberProfilesService,
  ) {}

  async execute(raw: TripV1.ManageTripRequest, correlation: string) {
    const actor = uuid(raw.actor_user_id),
      operation = uuid(raw.operation_id),
      tripId = uuid(raw.trip_id);
    const action = raw.action;
    if (
      !['ARCHIVE', 'DELETE', 'TRANSFER', 'REOPEN'].includes(action ?? '') ||
      typeof raw.reason !== 'string' ||
      !raw.reason.trim() ||
      raw.reason.includes('\0') ||
      [...raw.reason].length > 1000
    )
      return fail('VALIDATION_FAILED', 400);
    const expected = {
      plan: positiveRevision(raw.expected_plan_version),
      membership: positiveRevision(raw.expected_membership_revision),
      export: positiveRevision(raw.expected_export_revision),
    };
    const target = action === 'TRANSFER' ? uuid(raw.new_owner_member_id) : undefined;
    if (action !== 'TRANSFER' && raw.new_owner_member_id) return fail('VALIDATION_FAILED', 400);
    const operationType = `${action}_TRIP`,
      requestHash = digest({ actor, tripId, action, target, expected, reason: raw.reason.trim() });
    return this.repo.db.withTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='1500ms'");
      await lockOperation(client, operation);
      // Initiator-owned acknowledgement remains retrievable after deletion/ownership transfer.
      const saved = await receiptById(client, operation);
      if (saved)
        return verifyReceipt(saved, { operationType, actorUserId: actor, requestHash, tripId });
      const { trip, members } = await this.repo.lockTrip(client, tripId);
      const current = this.repo.actor(members, actor, true);
      if (members.filter((m) => !m.left_at && m.role === 'OWNER').length !== 1)
        return fail('STATE_CONFLICT', 409);
      if (
        trip.plan_version !== expected.plan ||
        trip.membership_revision !== expected.membership ||
        trip.export_revision !== expected.export
      )
        return fail('VERSION_CONFLICT', 409);
      if (
        trip.closure_lock_id ||
        [trip.plan_version, trip.membership_revision, trip.export_revision].some(
          (v) => v >= MAX_INT32,
        )
      )
        return fail('STATE_CONFLICT', 409);
      if (
        (action === 'ARCHIVE' && trip.archived_at) ||
        (action === 'REOPEN' && !trip.archived_at) ||
        (action === 'TRANSFER' && trip.archived_at)
      )
        return fail('STATE_CONFLICT', 409);
      if (
        (
          await client.query(
            "SELECT 1 FROM trip_operations WHERE trip_id=$1 AND state IN ('PROCESSING','PENDING_RECOVERY','NEEDS_REVIEW') LIMIT 1",
            [tripId],
          )
        ).rowCount
      )
        return fail('STATE_CONFLICT', 409);
      const next = target
        ? members.find((m) => m.id === target && !m.left_at && m.id !== current.id)
        : undefined;
      if (target && !next) return fail('VALIDATION_FAILED', 400);
      // Holding Trip's lock prevents every guarded Finance writer from beginning.
      // The Finance read only locks its own Fund rows and never calls back into Trip.
      if (next && !(await this.profiles.activeOwnerCandidate(next.user_id, correlation)))
        return fail('STATE_CONFLICT', 409);
      const state = await this.finance.lifecycleState(tripId, correlation);
      if (
        action === 'TRANSFER'
          ? state.can_transfer !== true
          : action !== 'REOPEN' && state.can_archive !== true
      )
        return fail('FINANCE_OBLIGATION_BLOCKED', 409);
      if (next) {
        await client.query(
          "UPDATE trip_members SET role='MEMBER',updated_at=clock_timestamp() WHERE id=$1",
          [current.id],
        );
        await client.query(
          "UPDATE trip_members SET role='OWNER',updated_at=clock_timestamp() WHERE id=$1",
          [next.id],
        );
        // Membership revision changes invalidate all previously captured Finance authority.
      }
      const row = (
        await client.query<{
          plan_version: number;
          membership_revision: number;
          export_revision: number;
        }>(
          `UPDATE trips SET
        plan_version=plan_version+1,membership_revision=membership_revision+1,export_revision=export_revision+1,
        archived_at=CASE WHEN $2='ARCHIVE' THEN clock_timestamp() WHEN $2='REOPEN' THEN NULL ELSE archived_at END,
        deleted_at=CASE WHEN $2='DELETE' THEN clock_timestamp() ELSE deleted_at END,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING plan_version,membership_revision,export_revision`,
          [tripId, action],
        )
      ).rows[0]!;
      await client.query(
        "UPDATE invitations SET status='REVOKED',version=version+1,delivery_token_ciphertext=NULL,delivery_token_expires_at=NULL WHERE trip_id=$1 AND status='PENDING'",
        [tripId],
      );
      await client.query(
        "INSERT INTO trip_audit_logs(trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,reason,details,correlation_id) VALUES($1,$2,$3,'Trip',$1,$4,$5,$6,$7::jsonb,$8)",
        [
          tripId,
          actor,
          operationType,
          trip.membership_revision,
          row.membership_revision,
          raw.reason!.trim(),
          JSON.stringify({ new_owner_user_id: next?.user_id }),
          correlation,
        ],
      );
      if (action !== 'TRANSFER') {
        const eventType =
          action === 'ARCHIVE'
            ? 'TripArchived'
            : action === 'DELETE'
              ? 'TripDeleted'
              : 'TripReopened';
        const at = new Date().toISOString();
        const payload = {
          trip_id: tripId,
          export_revision: row.export_revision,
          ...(action === 'DELETE' ? { deleted_at: at } : {}),
        };
        const event = parseEventForPublish({
          event_id: randomUUID(),
          event_type: eventType,
          schema_version: 1,
          aggregate_type: 'Trip',
          aggregate_id: tripId,
          aggregate_version: row.export_revision,
          producer: 'Trip',
          occurred_at: at,
          correlation_id: correlation,
          operation_id: operation,
          trip_id: tripId,
          actor_user_id: actor,
          causation_id: null,
          system_actor: null,
          payload,
        });
        await client.query(
          "INSERT INTO outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,correlation_id,payload,aggregate_type,producer,occurred_at,operation_id,trip_id,actor_user_id) VALUES($1,$2,1,$3,$4,$5,$6::jsonb,'Trip','Trip',$7,$8,$3,$9)",
          [
            event.event_id,
            eventType,
            tripId,
            row.export_revision,
            correlation,
            JSON.stringify(payload),
            at,
            operation,
            actor,
          ],
        );
      }
      const outcome = {
        id: tripId,
        action,
        ...row,
        ...(next ? { new_owner_user_id: next.user_id } : {}),
        ...(action === 'DELETE' ? { deleted: true } : {}),
      };
      await insertReceipt(client, {
        operationId: operation,
        tripId,
        operationType,
        actorUserId: actor,
        requestHash,
        contextRevision: row.membership_revision,
        outcome,
        commandPayload: { action, target, expected },
      });
      return outcome;
    });
  }

  async operationResult(operationId: unknown, actorId: unknown) {
    const row = await this.repo.db.withTransaction((client) =>
      receiptById(client, uuid(operationId)),
    );
    if (
      !row ||
      !['ARCHIVE_TRIP', 'DELETE_TRIP', 'TRANSFER_TRIP', 'REOPEN_TRIP'].includes(row.operation_type)
    )
      return undefined;
    if (row.actor_user_id !== uuid(actorId)) return fail('RESOURCE_NOT_FOUND', 404);
    return {
      operation_id: row.operation_id,
      trip_id: row.trip_id,
      state: CommonV1.OperationState.OPERATION_STATE_SUCCEEDED,
      outcome: { status: CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED, blocking_ids: [] },
    };
  }

  async reminderContext(
    raw: TripV1.GetAutomationContextRequest,
  ): Promise<TripV1.GetAutomationContextResponse> {
    const tripId = uuid(raw.trip_id),
      actor = uuid(raw.user_id),
      source = uuid(raw.source_id);
    const type = raw.source_type;
    if (!['ACTIVITY', 'PACKING'].includes(type ?? '')) return fail('VALIDATION_FAILED', 400);
    return this.repo.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const trip =
        (
          await client.query<{ plan_version: number; archived_at: Date | null }>(
            'SELECT t.plan_version,t.archived_at FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL WHERE t.id=$1 AND t.deleted_at IS NULL',
            [tripId, actor],
          )
        ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      const table = type === 'ACTIVITY' ? 'activities' : 'packing_items';
      const time = type === 'ACTIVITY' ? 'starts_at' : 'due_at';
      const item =
        (
          await client.query<{ status: string; due: Date | null }>(
            `SELECT status,${time} AS due FROM ${table} WHERE trip_id=$1 AND id=$2`,
            [tripId, source],
          )
        ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      return {
        context: {
          source_type: type,
          source_id: source,
          source_revision: trip.plan_version,
          state: item.status,
          allowed: !trip.archived_at && item.status !== 'COMPLETED' && Boolean(item.due),
          remind_at: item.due ? protobufTimestamp(item.due.toISOString()) : undefined,
          recipients: [{ user_id: actor }],
        },
      };
    });
  }
}
