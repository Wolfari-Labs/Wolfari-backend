import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { QueryResultRow } from 'pg';
import {
  accessAction,
  accessUuid,
  type AccessAction,
  type PlanEditPolicy,
} from './trip-access.domain';
import { fail } from './trip.errors';
import type { MembershipRole, MembershipView } from './trip.service';

interface QueryExecutor {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

type AccessRow = QueryResultRow & {
  trip_id: string;
  plan_edit_policy: PlanEditPolicy;
  plan_version: number;
  membership_revision: number;
  export_revision: number;
  archived_at: Date | string | null;
  membership_id: string;
  membership_user_id: string;
  membership_role: MembershipRole;
  membership_joined_at: Date | string;
  membership_left_at: Date | string | null;
  selected_editor: boolean;
};

export interface AccessContextView {
  trip_id: string;
  membership: MembershipView;
  policy: PlanEditPolicy;
  trip_state: 'ACTIVE' | 'ARCHIVED';
  revisions: {
    plan_version: number;
    membership_revision: number;
    export_revision: number;
  };
  allowed: boolean;
  permissions: AccessAction[];
  can_read_trip: boolean;
  can_update_trip_metadata: boolean;
  can_edit_plan: boolean;
}

export interface GetAccessContextInput {
  tripId: unknown;
  userId: unknown;
  action: unknown;
}

const SELECT_ACCESS = `SELECT
  t.id AS trip_id,t.plan_edit_policy,t.plan_version,t.membership_revision,t.export_revision,t.archived_at,
  m.id AS membership_id,m.user_id AS membership_user_id,m.role AS membership_role,
  m.joined_at AS membership_joined_at,m.left_at AS membership_left_at,
  EXISTS(
    SELECT 1 FROM trip_plan_editors pe
    WHERE pe.trip_id=t.id AND pe.trip_member_id=m.id
  ) AS selected_editor
FROM trips t
JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL
WHERE t.id=$1 AND t.deleted_at IS NULL`;

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid database timestamp');
  return parsed.toISOString();
}

function projectAccess(row: AccessRow, action: AccessAction): AccessContextView {
  const active = row.archived_at === null;
  const owner = row.membership_role === 'OWNER';
  const canReadTrip = true;
  const canUpdateTripMetadata = active && owner;
  const canEditPlan =
    active &&
    (owner ||
      row.plan_edit_policy === 'ALL_MEMBERS' ||
      (row.plan_edit_policy === 'SELECTED_MEMBERS' && row.selected_editor));
  const canUpdatePlanPolicy = active && owner;
  const permissions: AccessAction[] = [
    'TRIP_VIEW',
    ...(canUpdateTripMetadata ? (['TRIP_UPDATE_METADATA'] as AccessAction[]) : []),
    ...(canEditPlan ? (['PLAN_EDIT'] as AccessAction[]) : []),
    ...(canUpdatePlanPolicy ? (['PLAN_POLICY_UPDATE'] as AccessAction[]) : []),
  ];

  return {
    trip_id: row.trip_id,
    membership: {
      id: row.membership_id,
      trip_id: row.trip_id,
      user_id: row.membership_user_id,
      role: row.membership_role,
      joined_at: iso(row.membership_joined_at),
      left_at: row.membership_left_at === null ? null : iso(row.membership_left_at),
    },
    policy: row.plan_edit_policy,
    trip_state: active ? 'ACTIVE' : 'ARCHIVED',
    revisions: {
      plan_version: row.plan_version,
      membership_revision: row.membership_revision,
      export_revision: row.export_revision,
    },
    allowed: permissions.includes(action),
    permissions,
    can_read_trip: canReadTrip,
    can_update_trip_metadata: canUpdateTripMetadata,
    can_edit_plan: canEditPlan,
  };
}

@Injectable()
export class TripAccessService {
  constructor(private readonly database: DatabaseProvider) {}

  async getContext(input: GetAccessContextInput): Promise<AccessContextView> {
    return this.loadContext(this.database, input, false);
  }

  async getContextForUpdate(
    client: QueryExecutor,
    input: GetAccessContextInput,
  ): Promise<AccessContextView> {
    return this.loadContext(client, input, true);
  }

  private async loadContext(
    executor: QueryExecutor,
    input: GetAccessContextInput,
    lock: boolean,
  ): Promise<AccessContextView> {
    const tripId = accessUuid(input.tripId);
    const userId = accessUuid(input.userId);
    const action = accessAction(input.action);
    if (lock) {
      // Caller must keep this transaction open through the Plan mutation. Read
      // assignments in a separate statement so READ COMMITTED refreshes the
      // snapshot after waiting for an in-flight policy change to release its lock.
      const locked = await executor.query(
        `SELECT t.id FROM trips t
         JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL
         WHERE t.id=$1 AND t.deleted_at IS NULL FOR UPDATE OF t,m`,
        [tripId, userId],
      );
      if (!locked.rows[0]) return fail('RESOURCE_NOT_FOUND', 404);
    }
    const result = await executor.query<AccessRow>(SELECT_ACCESS, [tripId, userId]);
    const row = result.rows[0];
    if (!row) return fail('RESOURCE_NOT_FOUND', 404);
    return projectAccess(row, action);
  }
}
