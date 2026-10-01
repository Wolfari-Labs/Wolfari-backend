import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import {
  UUID,
  TripError,
  digest,
  fail,
  insertReceipt,
  instant,
  iso,
  lockOperation,
  nullableText,
  positiveRevision,
  receiptById,
  uuid,
  verifyReceipt,
  type OperationRow,
} from './trip-common';
export { TripError } from './trip-common';

const CREATE_OPERATION = 'CREATE_TRIP';
const UPDATE_OPERATION = 'UPDATE_TRIP_METADATA';

export type TripLifecycle = 'UPCOMING' | 'ONGOING' | 'COMPLETED' | 'ARCHIVED';
export type MembershipRole = 'OWNER' | 'MEMBER';
export type TripPermission = 'TRIP_VIEW' | 'TRIP_UPDATE_METADATA';

export interface MembershipView {
  id: string;
  trip_id: string;
  user_id: string;
  role: MembershipRole;
  joined_at: string;
  left_at: string | null;
}

export interface TripView {
  id: string;
  name: string;
  description: string | null;
  start_at: string;
  end_at: string;
  timezone: string;
  lifecycle: TripLifecycle;
  archived_at: string | null;
  public_description: string | null;
  plan_edit_policy: 'OWNER_ONLY' | 'SELECTED_MEMBERS' | 'ALL_MEMBERS';
  plan_version: number;
  membership_revision: number;
  export_revision: number;
  current_membership: MembershipView;
  permissions: TripPermission[];
}

export interface CreateTripInput {
  actorUserId: unknown;
  operationId: unknown;
  name: unknown;
  description?: unknown;
  startAt: unknown;
  endAt: unknown;
  timezone?: unknown;
  correlationId: unknown;
}

export interface UpdateTripInput {
  actorUserId: unknown;
  operationId: unknown;
  tripId: unknown;
  expectedPlanVersion: unknown;
  expectedExportRevision: unknown;
  fields: Record<string, unknown>;
  correlationId: unknown;
}

export interface ListTripsInput {
  actorUserId: unknown;
  limit?: unknown;
  cursor?: unknown;
  lifecycle?: unknown;
}

type TripRow = {
  id: string;
  name: string;
  description: string | null;
  start_at: Date | string;
  end_at: Date | string;
  timezone: string;
  plan_edit_policy: TripView['plan_edit_policy'];
  plan_version: number;
  membership_revision: number;
  export_revision: number;
  archived_at: Date | string | null;
  created_at: Date | string;
  public_description: string | null;
  membership_id: string;
  membership_user_id: string;
  membership_role: MembershipRole;
  membership_joined_at: Date | string;
  membership_left_at: Date | string | null;
};

function tripName(value: unknown): string {
  if (typeof value !== 'string') return fail('VALIDATION_FAILED', 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) return fail('VALIDATION_FAILED', 400);
  return normalized;
}

function timeZone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64)
    return fail('VALIDATION_FAILED', 400);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    return fail('VALIDATION_FAILED', 400);
  }
  return value;
}

export function lifecycleAt(
  row: Pick<TripRow, 'start_at' | 'end_at' | 'archived_at'>,
  now = new Date(),
): TripLifecycle {
  if (row.archived_at !== null) return 'ARCHIVED';
  if (new Date(row.start_at).getTime() > now.getTime()) return 'UPCOMING';
  if (new Date(row.end_at).getTime() <= now.getTime()) return 'COMPLETED';
  return 'ONGOING';
}

function project(row: TripRow, now = new Date()): TripView {
  const archivedAt = row.archived_at === null ? null : iso(row.archived_at);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    start_at: iso(row.start_at),
    end_at: iso(row.end_at),
    timezone: row.timezone,
    lifecycle: lifecycleAt(row, now),
    archived_at: archivedAt,
    public_description: row.public_description,
    plan_edit_policy: row.plan_edit_policy,
    plan_version: row.plan_version,
    membership_revision: row.membership_revision,
    export_revision: row.export_revision,
    current_membership: {
      id: row.membership_id,
      trip_id: row.id,
      user_id: row.membership_user_id,
      role: row.membership_role,
      joined_at: iso(row.membership_joined_at),
      left_at: row.membership_left_at === null ? null : iso(row.membership_left_at),
    },
    permissions: [
      'TRIP_VIEW',
      ...(row.membership_role === 'OWNER' && archivedAt === null
        ? (['TRIP_UPDATE_METADATA'] as TripPermission[])
        : []),
    ],
  };
}

function cursorFor(actorUserId: string, lifecycle: TripLifecycle | null, row: TripRow): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      actor_user_id: actorUserId,
      lifecycle,
      created_at: iso(row.created_at),
      id: row.id,
    }),
  ).toString('base64url');
}

export function parseCursor(
  raw: unknown,
  actorUserId: string,
  lifecycle: TripLifecycle | null,
): { createdAt: string | null; id: string | null } {
  if (raw === undefined || raw === null || raw === '') return { createdAt: null, id: null };
  if (typeof raw !== 'string' || raw.length > 2048) return fail('VALIDATION_FAILED', 400);
  try {
    const decoded = Buffer.from(raw, 'base64url');
    if (decoded.toString('base64url') !== raw) return fail('VALIDATION_FAILED', 400);
    const value = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'actor_user_id,created_at,id,lifecycle,version' ||
      value.version !== 1 ||
      value.actor_user_id !== actorUserId ||
      value.lifecycle !== lifecycle ||
      typeof value.created_at !== 'string' ||
      Number.isNaN(Date.parse(value.created_at)) ||
      typeof value.id !== 'string' ||
      !UUID.test(value.id)
    ) {
      return fail('VALIDATION_FAILED', 400);
    }
    return { createdAt: new Date(value.created_at).toISOString(), id: value.id.toLowerCase() };
  } catch (error) {
    if (error instanceof TripError) throw error;
    return fail('VALIDATION_FAILED', 400);
  }
}

const SELECT_TRIP = `SELECT
  t.id,t.name,t.description,t.start_at,t.end_at,t.timezone,t.plan_edit_policy,
  t.plan_version,t.membership_revision,t.export_revision,t.archived_at,t.created_at,t.public_description,
  m.id AS membership_id,m.user_id AS membership_user_id,m.role AS membership_role,
  m.joined_at AS membership_joined_at,m.left_at AS membership_left_at
FROM trips t
JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL
WHERE t.id=$1 AND t.deleted_at IS NULL`;

function operationOutcome(value: unknown, expectedTripId: string): TripView {
  const outcome = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (
    !outcome ||
    typeof outcome !== 'object' ||
    (outcome as { id?: unknown }).id !== expectedTripId
  ) {
    throw new Error('Invalid operation outcome');
  }
  return outcome as TripView;
}

function verifyReplay(
  receipt: OperationRow,
  input: {
    operationType: string;
    actorUserId: string;
    requestHash: string;
    tripId?: string;
  },
): TripView {
  return operationOutcome(verifyReceipt(receipt, input), receipt.trip_id);
}

@Injectable()
export class TripService {
  constructor(private readonly database: DatabaseProvider) {}

  async create(input: CreateTripInput): Promise<TripView> {
    const actorUserId = uuid(input.actorUserId);
    const operationId = uuid(input.operationId);
    const correlationId = uuid(input.correlationId);
    const name = tripName(input.name);
    const description = input.description === undefined ? null : nullableText(input.description);
    const startAt = instant(input.startAt);
    const endAt = instant(input.endAt);
    const timezone = timeZone(input.timezone === undefined ? 'Asia/Ho_Chi_Minh' : input.timezone);
    if (endAt.getTime() <= startAt.getTime()) return fail('VALIDATION_FAILED', 400);

    const commandPayload = {
      name,
      description,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      timezone,
    };
    const requestHash = digest({
      actor_user_id: actorUserId,
      command: CREATE_OPERATION,
      payload: commandPayload,
    });

    return this.database.withTransaction(async (client) => {
      await lockOperation(client, operationId);
      const receipt = await receiptById(client, operationId);
      if (receipt) {
        verifyReplay(receipt, { operationType: CREATE_OPERATION, actorUserId, requestHash });
        const access = await client.query<TripRow>(SELECT_TRIP, [receipt.trip_id, actorUserId]);
        if (!access.rows[0]) return fail('RESOURCE_NOT_FOUND', 404);
        return project(access.rows[0]);
      }

      const created = await client.query<TripRow>(
        `INSERT INTO trips(name,description,start_at,end_at,timezone,plan_edit_policy,created_by_user_id,
           plan_version,membership_revision,export_revision)
         VALUES($1,$2,$3,$4,$5,'OWNER_ONLY',$6,1,1,1)
         RETURNING id,name,description,start_at,end_at,timezone,plan_edit_policy,plan_version,
           membership_revision,export_revision,archived_at,created_at,public_description`,
        [name, description, startAt, endAt, timezone, actorUserId],
      );
      const trip = created.rows[0];
      if (!trip) throw new Error('Trip insert returned no row');
      const membership = await client.query<{
        id: string;
        user_id: string;
        role: MembershipRole;
        joined_at: Date | string;
        left_at: Date | string | null;
      }>(
        `INSERT INTO trip_members(trip_id,user_id,role,joined_at)
         VALUES($1,$2,'OWNER',now()) RETURNING id,user_id,role,joined_at,left_at`,
        [trip.id, actorUserId],
      );
      const owner = membership.rows[0];
      if (!owner) throw new Error('Owner membership insert returned no row');
      const row: TripRow = {
        ...trip,
        membership_id: owner.id,
        membership_user_id: owner.user_id,
        membership_role: owner.role,
        membership_joined_at: owner.joined_at,
        membership_left_at: owner.left_at,
      };
      const outcome = project(row);
      await client.query(
        `INSERT INTO trip_audit_logs(
           trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,details,correlation_id
         ) VALUES($1,$2,'TRIP_CREATED','TRIP',$1,NULL,1,$3::jsonb,$4)`,
        [
          trip.id,
          actorUserId,
          JSON.stringify({ changed_fields: Object.keys(commandPayload) }),
          correlationId,
        ],
      );
      await insertReceipt(client, {
        operationId,
        tripId: trip.id,
        operationType: CREATE_OPERATION,
        actorUserId,
        requestHash,
        contextRevision: 1,
        outcome,
        commandPayload,
      });
      return outcome;
    });
  }

  async list(input: ListTripsInput): Promise<{ items: TripView[]; next_cursor: string | null }> {
    const actorUserId = uuid(input.actorUserId);
    const limit = input.limit === undefined ? 20 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('VALIDATION_FAILED', 400);
    const lifecycle =
      input.lifecycle === undefined || input.lifecycle === null || input.lifecycle === ''
        ? null
        : input.lifecycle;
    if (
      lifecycle !== null &&
      lifecycle !== 'UPCOMING' &&
      lifecycle !== 'ONGOING' &&
      lifecycle !== 'COMPLETED' &&
      lifecycle !== 'ARCHIVED'
    ) {
      return fail('VALIDATION_FAILED', 400);
    }
    const cursor = parseCursor(input.cursor, actorUserId, lifecycle);
    const now = new Date();
    const lifecycleSql: Record<TripLifecycle | 'DEFAULT', string> = {
      DEFAULT: 't.archived_at IS NULL',
      UPCOMING: 't.archived_at IS NULL AND t.start_at>$4',
      ONGOING: 't.archived_at IS NULL AND t.start_at<=$4 AND t.end_at>$4',
      COMPLETED: 't.archived_at IS NULL AND t.end_at<=$4',
      ARCHIVED: 't.archived_at IS NOT NULL',
    };
    const result = await this.database.query<TripRow>(
      `SELECT
         t.id,t.name,t.description,t.start_at,t.end_at,t.timezone,t.plan_edit_policy,
         t.plan_version,t.membership_revision,t.export_revision,t.archived_at,t.created_at,t.public_description,
         m.id AS membership_id,m.user_id AS membership_user_id,m.role AS membership_role,
         m.joined_at AS membership_joined_at,m.left_at AS membership_left_at
       FROM trips t
       JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$1 AND m.left_at IS NULL
       WHERE t.deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR (t.created_at,t.id)<($2::timestamptz,$3::uuid))
         AND $4::timestamptz IS NOT NULL
         AND ${lifecycleSql[lifecycle ?? 'DEFAULT']}
       ORDER BY t.created_at DESC,t.id DESC
       LIMIT $5`,
      [actorUserId, cursor.createdAt, cursor.id, now, limit + 1],
    );
    const shown = result.rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      items: shown.map((row) => project(row, now)),
      next_cursor:
        result.rows.length > limit && last ? cursorFor(actorUserId, lifecycle, last) : null,
    };
  }

  async get(actorUserIdInput: unknown, tripIdInput: unknown): Promise<TripView> {
    const actorUserId = uuid(actorUserIdInput);
    const tripId = uuid(tripIdInput);
    const result = await this.database.query<TripRow>(SELECT_TRIP, [tripId, actorUserId]);
    const row = result.rows[0];
    if (!row) return fail('RESOURCE_NOT_FOUND', 404);
    return project(row);
  }

  async update(input: UpdateTripInput): Promise<TripView> {
    const actorUserId = uuid(input.actorUserId);
    const operationId = uuid(input.operationId);
    const tripId = uuid(input.tripId);
    const correlationId = uuid(input.correlationId);
    const expectedPlanVersion = positiveRevision(input.expectedPlanVersion);
    const expectedExportRevision = positiveRevision(input.expectedExportRevision);
    const allowed = ['description', 'name', 'public_description'];
    if (
      !input.fields ||
      Array.isArray(input.fields) ||
      Object.keys(input.fields).some((key) => !allowed.includes(key)) ||
      Object.keys(input.fields).length === 0
    ) {
      return fail('VALIDATION_FAILED', 400);
    }
    const fields: {
      name?: string;
      description?: string | null;
      public_description?: string | null;
    } = {};
    if ('name' in input.fields) fields.name = tripName(input.fields.name);
    if ('description' in input.fields) fields.description = nullableText(input.fields.description);
    if ('public_description' in input.fields) {
      fields.public_description = nullableText(input.fields.public_description);
    }
    const commandPayload = {
      expected_plan_version: expectedPlanVersion,
      expected_export_revision: expectedExportRevision,
      fields,
    };
    const requestHash = digest({
      actor_user_id: actorUserId,
      command: UPDATE_OPERATION,
      trip_id: tripId,
      payload: commandPayload,
    });

    return this.database.withTransaction(async (client) => {
      await lockOperation(client, operationId);
      const access = await client.query<TripRow>(`${SELECT_TRIP} FOR UPDATE OF t,m`, [
        tripId,
        actorUserId,
      ]);
      let row = access.rows[0];
      if (!row) return fail('RESOURCE_NOT_FOUND', 404);
      if (row.membership_role !== 'OWNER') return fail('PERMISSION_DENIED', 403);

      const receipt = await receiptById(client, operationId);
      if (receipt) {
        verifyReplay(receipt, {
          operationType: UPDATE_OPERATION,
          actorUserId,
          requestHash,
          tripId,
        });
        return project(row);
      }
      if (row.archived_at !== null) return fail('STATE_CONFLICT', 409);
      if (
        row.plan_version !== expectedPlanVersion ||
        row.export_revision !== expectedExportRevision
      ) {
        return fail('VERSION_CONFLICT', 409, {
          plan_version: row.plan_version,
          export_revision: row.export_revision,
        });
      }

      const changedFields = Object.entries(fields)
        .filter(
          ([key, value]) => row[key as 'name' | 'description' | 'public_description'] !== value,
        )
        .map(([key]) => key);
      if (changedFields.length > 0) {
        const updated = await client.query<TripRow>(
          `UPDATE trips SET
             name=CASE WHEN $2 THEN $3 ELSE name END,
             description=CASE WHEN $4 THEN $5 ELSE description END,
             public_description=CASE WHEN $6 THEN $7 ELSE public_description END,
             export_revision=export_revision+1,updated_at=now()
           WHERE id=$1
           RETURNING id,name,description,start_at,end_at,timezone,plan_edit_policy,plan_version,
             membership_revision,export_revision,archived_at,created_at,public_description`,
          [
            tripId,
            'name' in fields,
            fields.name ?? null,
            'description' in fields,
            fields.description ?? null,
            'public_description' in fields,
            fields.public_description ?? null,
          ],
        );
        const trip = updated.rows[0];
        if (!trip) throw new Error('Trip update returned no row');
        const previousExportRevision = row.export_revision;
        row = {
          ...trip,
          membership_id: row.membership_id,
          membership_user_id: row.membership_user_id,
          membership_role: row.membership_role,
          membership_joined_at: row.membership_joined_at,
          membership_left_at: row.membership_left_at,
        };
        await client.query(
          `INSERT INTO trip_audit_logs(
             trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,details,correlation_id
           ) VALUES($1,$2,'TRIP_METADATA_UPDATED','TRIP',$1,$3,$4,$5::jsonb,$6)`,
          [
            tripId,
            actorUserId,
            previousExportRevision,
            row.export_revision,
            JSON.stringify({ changed_fields: changedFields }),
            correlationId,
          ],
        );
      }

      const outcome = project(row);
      await insertReceipt(client, {
        operationId,
        tripId,
        operationType: UPDATE_OPERATION,
        actorUserId,
        requestHash,
        contextRevision: row.export_revision,
        outcome,
        commandPayload,
      });
      return outcome;
    });
  }
}
