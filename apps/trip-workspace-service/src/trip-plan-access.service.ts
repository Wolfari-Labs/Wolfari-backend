import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { QueryResultRow } from 'pg';
import {
  digest,
  insertReceipt,
  lockOperation,
  receiptById,
  verifyReceipt,
  type OperationRow,
  type QueryClient,
} from './trip-common';
import {
  accessRevision,
  accessUuid,
  editorMemberIds,
  maximumRevision,
  planEditPolicy,
  type PlanEditPolicy,
  type PlanPolicyView,
} from './trip-access.domain';
import { fail } from './trip.errors';
import type { MembershipRole } from './trip.service';

const UPDATE_PLAN_POLICY = 'UPDATE_PLAN_POLICY';

type OwnerRow = QueryResultRow & {
  trip_id: string;
  plan_edit_policy: PlanEditPolicy;
  membership_revision: number;
  archived_at: Date | string | null;
  membership_id: string;
  membership_role: MembershipRole;
};

export interface UpdatePlanPolicyInput {
  operationId: unknown;
  actorUserId: unknown;
  tripId: unknown;
  policy: unknown;
  editorMemberIds: unknown;
  expectedMembershipRevision: unknown;
  correlationId: unknown;
}

export function planPolicyRequestHash(input: {
  actorUserId: string;
  tripId: string;
  policy: PlanEditPolicy;
  editorMemberIds: string[];
  expectedMembershipRevision: number;
}): string {
  return digest({
    actor_user_id: input.actorUserId,
    command: UPDATE_PLAN_POLICY,
    trip_id: input.tripId,
    payload: {
      policy: input.policy,
      editor_member_ids: input.editorMemberIds,
      expected_membership_revision: input.expectedMembershipRevision,
    },
  });
}

function verifyReplay(
  receipt: OperationRow,
  values: { actorUserId: string; tripId: string; requestHash: string },
): PlanPolicyView {
  const outcome = verifyReceipt(receipt, { ...values, operationType: UPDATE_PLAN_POLICY });
  if (
    !outcome ||
    typeof outcome !== 'object' ||
    !Array.isArray((outcome as Partial<PlanPolicyView>).editor_member_ids) ||
    typeof (outcome as Partial<PlanPolicyView>).membership_revision !== 'number'
  ) {
    throw new Error('Invalid operation outcome');
  }
  const stored = outcome as Partial<PlanPolicyView>;
  try {
    // Whitelist the persisted response; do not expose receipt metadata or rebuild
    // it from current state, which may have changed since this command succeeded.
    return {
      policy: planEditPolicy(stored.policy),
      editor_member_ids: editorMemberIds(stored.editor_member_ids),
      membership_revision: accessRevision(stored.membership_revision),
    };
  } catch {
    throw new Error('Invalid operation outcome');
  }
}

async function activeEditorIds(client: QueryClient, tripId: string): Promise<string[]> {
  const result = await client.query<{ trip_member_id: string }>(
    `SELECT pe.trip_member_id
     FROM trip_plan_editors pe
     JOIN trip_members m ON m.id=pe.trip_member_id AND m.trip_id=pe.trip_id
     WHERE pe.trip_id=$1 AND m.left_at IS NULL AND m.role='MEMBER'
     ORDER BY pe.trip_member_id`,
    [tripId],
  );
  return result.rows.map((row) => row.trip_member_id);
}

async function policyView(
  client: QueryClient,
  row: Pick<OwnerRow, 'trip_id' | 'plan_edit_policy' | 'membership_revision'>,
): Promise<PlanPolicyView> {
  return {
    policy: row.plan_edit_policy,
    editor_member_ids: await activeEditorIds(client, row.trip_id),
    membership_revision: row.membership_revision,
  };
}

@Injectable()
export class TripPlanAccessService {
  constructor(private readonly database: DatabaseProvider) {}

  async updatePolicy(input: UpdatePlanPolicyInput): Promise<PlanPolicyView> {
    const operationId = accessUuid(input.operationId);
    const actorUserId = accessUuid(input.actorUserId);
    const tripId = accessUuid(input.tripId);
    const policy = planEditPolicy(input.policy);
    const requestedEditorIds = editorMemberIds(input.editorMemberIds);
    const expectedRevision = accessRevision(input.expectedMembershipRevision);
    const correlationId = accessUuid(input.correlationId);
    if (policy !== 'SELECTED_MEMBERS' && requestedEditorIds.length > 0) {
      return fail('VALIDATION_FAILED', 400);
    }
    const requestHash = planPolicyRequestHash({
      actorUserId,
      tripId,
      policy,
      editorMemberIds: requestedEditorIds,
      expectedMembershipRevision: expectedRevision,
    });
    const commandPayload = {
      policy,
      editor_member_ids: requestedEditorIds,
      expected_membership_revision: expectedRevision,
    };

    return this.database.withTransaction(async (client) => {
      await lockOperation(client, operationId);
      await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [tripId]);
      await client.query('SELECT id FROM trip_members WHERE trip_id=$1 ORDER BY id FOR UPDATE', [
        tripId,
      ]);
      const access = await client.query<OwnerRow>(
        `SELECT t.id AS trip_id,t.plan_edit_policy,t.membership_revision,t.archived_at,
           m.id AS membership_id,m.role AS membership_role
         FROM trips t
         JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL
         WHERE t.id=$1 AND t.deleted_at IS NULL
         FOR UPDATE OF t,m`,
        [tripId, actorUserId],
      );
      let row = access.rows[0];
      if (!row) return fail('RESOURCE_NOT_FOUND', 404);
      if (row.membership_role !== 'OWNER') return fail('PERMISSION_DENIED', 403);

      const receipt = await receiptById(client, operationId);
      if (receipt) {
        return verifyReplay(receipt, { actorUserId, tripId, requestHash });
      }
      if (row.archived_at !== null) return fail('STATE_CONFLICT', 409);
      if (row.membership_revision !== expectedRevision) {
        return fail('VERSION_CONFLICT', 409, {
          membership_revision: row.membership_revision,
        });
      }

      const currentAssignments = await client.query<{ trip_member_id: string }>(
        `SELECT trip_member_id FROM trip_plan_editors
         WHERE trip_id=$1 ORDER BY trip_member_id FOR UPDATE`,
        [tripId],
      );
      const currentEditorIds = currentAssignments.rows.map((item) => item.trip_member_id);

      if (policy === 'SELECTED_MEMBERS' && requestedEditorIds.length > 0) {
        const members = await client.query<{ id: string }>(
          `SELECT id FROM trip_members
           WHERE trip_id=$1 AND id=ANY($2::uuid[]) AND role='MEMBER' AND left_at IS NULL
           ORDER BY id FOR UPDATE`,
          [tripId, requestedEditorIds],
        );
        if (members.rows.length !== requestedEditorIds.length) {
          return fail('VALIDATION_FAILED', 400);
        }
      }

      const targetEditorIds = policy === 'SELECTED_MEMBERS' ? requestedEditorIds : currentEditorIds;
      const currentSet = new Set(currentEditorIds);
      const targetSet = new Set(targetEditorIds);
      const added = targetEditorIds.filter((id) => !currentSet.has(id));
      const removed = currentEditorIds.filter((id) => !targetSet.has(id));
      const changed = row.plan_edit_policy !== policy || added.length > 0 || removed.length > 0;

      if (changed) {
        if (row.membership_revision >= maximumRevision) return fail('STATE_CONFLICT', 409);
        if (policy === 'SELECTED_MEMBERS') {
          await client.query(
            `DELETE FROM trip_plan_editors
             WHERE trip_id=$1 AND NOT (trip_member_id=ANY($2::uuid[]))`,
            [tripId, targetEditorIds],
          );
          if (added.length > 0) {
            await client.query(
              `INSERT INTO trip_plan_editors(trip_id,trip_member_id,granted_by_user_id)
               SELECT $1,editor_id,$3 FROM unnest($2::uuid[]) AS editor_id
               ON CONFLICT (trip_id,trip_member_id) DO NOTHING`,
              [tripId, added, actorUserId],
            );
          }
        }

        const previousPolicy = row.plan_edit_policy;
        const previousRevision = row.membership_revision;
        const updated = await client.query<{ membership_revision: number }>(
          `UPDATE trips SET plan_edit_policy=$2,membership_revision=membership_revision+1,updated_at=now()
           WHERE id=$1 RETURNING membership_revision`,
          [tripId, policy],
        );
        const membershipRevision = updated.rows[0]?.membership_revision;
        if (!membershipRevision) throw new Error('Trip policy update returned no row');
        row = { ...row, plan_edit_policy: policy, membership_revision: membershipRevision };
        await client.query(
          `INSERT INTO trip_audit_logs(
             trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,details,correlation_id
           ) VALUES($1,$2,'PLAN_ACCESS_UPDATED','TRIP',$1,$3,$4,$5::jsonb,$6)`,
          [
            tripId,
            actorUserId,
            previousRevision,
            membershipRevision,
            JSON.stringify({
              from_policy: previousPolicy,
              to_policy: policy,
              added_editor_member_ids: added,
              removed_editor_member_ids: removed,
            }),
            correlationId,
          ],
        );
      }

      const outcome = await policyView(client, row);
      await insertReceipt(client, {
        operationId,
        tripId,
        operationType: UPDATE_PLAN_POLICY,
        actorUserId,
        requestHash,
        contextRevision: outcome.membership_revision,
        outcome,
        commandPayload,
      });
      return outcome;
    });
  }
}
