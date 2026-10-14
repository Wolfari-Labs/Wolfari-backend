import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import {
  digest,
  fail,
  instant,
  iso,
  MAX_INT32,
  nullableText,
  positiveRevision,
  uuid,
  lockOperation,
  receiptById,
  verifyReceipt,
  insertReceipt,
  type QueryClient,
} from '../trip-common';
import {
  ACCESS_SQL,
  ACTIVITY_COLUMNS,
  projectActivity,
  readPlanLists,
  type AccessRow,
  type ActivityRow,
  type ActivityView,
  type PlanPolicy,
  type PlanVersion,
  type PlanView,
} from './plan.projection';
import { insertPlanUpdated, type PlanChange } from './plan.events';

export interface PlanCommandInput {
  actorUserId: unknown;
  operationId: unknown;
  tripId: unknown;
  expectedPlanVersion: unknown;
  correlationId: unknown;
}
type Command =
  | 'CREATE_ACTIVITY'
  | 'UPDATE_ACTIVITY'
  | 'DELETE_ACTIVITY'
  | 'REORDER_ACTIVITIES'
  | 'SET_ACTIVITY_COMPLETION';
type Fields = {
  title?: string;
  activity_type?: string;
  description?: string | null;
  public_description?: string | null;
  selected_location_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  position?: number;
};
export interface MutationResult {
  version: PlanVersion;
  activity?: ActivityView;
}
type NormalizedCommand = {
  command: Command;
  operationId: string;
  actorUserId: string;
  tripId: string;
  correlationId: string;
  expectedPlanVersion: number;
  activityId?: string;
  fields?: Fields;
  activityIds?: string[];
  status?: 'TODO' | 'COMPLETED';
  confirmed?: true;
};
export function isPlanEditor(role: 'OWNER' | 'MEMBER', policy: PlanPolicy, selected: boolean) {
  return (
    role === 'OWNER' || policy === 'ALL_MEMBERS' || (policy === 'SELECTED_MEMBERS' && selected)
  );
}
function position(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_INT32)
    return fail('VALIDATION_FAILED', 400);
  return Number(value);
}
function label(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    return fail('VALIDATION_FAILED', 400);
  return value.trim();
}
export function validateTimes(
  starts: string | null,
  ends: string | null,
  trip?: Pick<AccessRow, 'start_at' | 'end_at'>,
): void {
  if ((starts === null) !== (ends === null)) return fail('VALIDATION_FAILED', 400);
  if (
    starts !== null &&
    ends !== null &&
    (Date.parse(ends) <= Date.parse(starts) ||
      (trip &&
        (Date.parse(starts) < Date.parse(iso(trip.start_at)) ||
          Date.parse(ends) > Date.parse(iso(trip.end_at)))))
  )
    return fail('VALIDATION_FAILED', 400);
}
export function normalizeActivityFields(value: unknown, create: boolean): Fields {
  const allowed = [
    'title',
    'activity_type',
    'description',
    'public_description',
    'selected_location_id',
    'starts_at',
    'ends_at',
    'position',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.keys(value).length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return fail('VALIDATION_FAILED', 400);
  const input = value as Record<string, unknown>;
  const fields: Fields = {};
  if (create || Object.hasOwn(input, 'title')) fields.title = label(input.title, 255);
  if (create || Object.hasOwn(input, 'activity_type'))
    fields.activity_type = label(input.activity_type, 40);
  for (const key of ['description', 'public_description'] as const) {
    if (Object.hasOwn(input, key)) fields[key] = nullableText(input[key]);
    else if (create) fields[key] = null;
  }
  if (Object.hasOwn(input, 'selected_location_id'))
    fields.selected_location_id =
      input.selected_location_id === null ? null : uuid(input.selected_location_id);
  else if (create) fields.selected_location_id = null;
  for (const key of ['starts_at', 'ends_at'] as const) {
    if (Object.hasOwn(input, key))
      fields[key] = input[key] === null ? null : instant(input[key]).toISOString();
    else if (create) fields[key] = null;
  }
  if (create || Object.hasOwn(input, 'position')) fields.position = position(input.position);
  if (create || (Object.hasOwn(fields, 'starts_at') && Object.hasOwn(fields, 'ends_at')))
    validateTimes(fields.starts_at ?? null, fields.ends_at ?? null);
  return fields;
}
export function orderedIds(ids: string[], id: string, target: number): string[] {
  const rest = ids.filter((value) => value !== id);
  if (target > rest.length) return fail('VALIDATION_FAILED', 400);
  rest.splice(target, 0, id);
  return rest;
}
export function validatePermutation(current: string[], next: string[]): void {
  const expected = new Set(current);
  if (
    next.length !== current.length ||
    new Set(next).size !== next.length ||
    next.some((id) => !expected.has(id))
  )
    return fail('VALIDATION_FAILED', 400);
}
export function planRequestHash(input: NormalizedCommand): string {
  return digest({
    actor_user_id: input.actorUserId,
    command: input.command,
    trip_id: input.tripId,
    ...(input.activityId ? { activity_id: input.activityId } : {}),
    payload: commandPayload(input),
  });
}
function commandPayload(input: NormalizedCommand) {
  return {
    expected_plan_version: input.expectedPlanVersion,
    ...(input.fields ? { fields: input.fields } : {}),
    ...(input.activityIds ? { activity_ids: input.activityIds } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.confirmed ? { confirmed: true } : {}),
  };
}
function base(input: PlanCommandInput, command: Command): NormalizedCommand {
  return {
    command,
    operationId: uuid(input.operationId),
    actorUserId: uuid(input.actorUserId),
    tripId: uuid(input.tripId),
    correlationId: uuid(input.correlationId),
    expectedPlanVersion: positiveRevision(input.expectedPlanVersion),
  };
}
async function activityById(client: QueryClient, tripId: string, activityId: string) {
  const result = await client.query<ActivityRow>(
    `SELECT ${ACTIVITY_COLUMNS} FROM activities
    WHERE id=$1 AND trip_id=$2 FOR UPDATE`,
    [activityId, tripId],
  );
  return result.rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
}
async function writeOrder(client: QueryClient, tripId: string, ids: string[]): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE activities a
    SET position=(v.ord-1)::integer,updated_at=now()
    FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id,ord)
    WHERE a.id=v.id AND a.trip_id=$1 AND a.position<>v.ord-1 RETURNING a.id`,
    [tripId, ids],
  );
  return result.rows.map((row) => row.id);
}
function savedOutcome(value: unknown, input: NormalizedCommand): MutationResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid Plan receipt');
  const saved = value as MutationResult;
  if (
    saved.version?.trip_id !== input.tripId ||
    !Number.isInteger(saved.version.plan_version) ||
    !Number.isInteger(saved.version.export_revision)
  )
    throw new Error('Invalid Plan receipt');
  if (
    ['CREATE_ACTIVITY', 'UPDATE_ACTIVITY', 'SET_ACTIVITY_COMPLETION'].includes(input.command) &&
    (!saved.activity ||
      saved.activity.trip_id !== input.tripId ||
      (input.activityId && saved.activity.id !== input.activityId))
  )
    throw new Error('Invalid activity receipt');
  return saved;
}

@Injectable()
export class PlanService {
  constructor(private readonly database: DatabaseProvider) {}

  async getPlan(actor: unknown, trip: unknown): Promise<PlanView> {
    const actorUserId = uuid(actor),
      tripId = uuid(trip);
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const access = await client.query<AccessRow>(ACCESS_SQL, [tripId, actorUserId]);
      const row = access.rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      return {
        trip_id: tripId,
        plan_version: row.plan_version,
        export_revision: row.export_revision,
        ...(await readPlanLists(client, tripId, row.plan_version)),
        permissions: {
          can_read: true,
          can_edit:
            row.archived_at === null &&
            isPlanEditor(row.role, row.plan_edit_policy, row.selected_editor),
          can_complete: row.archived_at === null,
        },
      };
    });
  }
  async createActivity(input: PlanCommandInput & { fields: unknown }): Promise<MutationResult> {
    return this.write({
      ...base(input, 'CREATE_ACTIVITY'),
      fields: normalizeActivityFields(input.fields, true),
    });
  }
  async updateActivity(
    input: PlanCommandInput & { activityId: unknown; fields: unknown },
  ): Promise<MutationResult> {
    return this.write({
      ...base(input, 'UPDATE_ACTIVITY'),
      activityId: uuid(input.activityId),
      fields: normalizeActivityFields(input.fields, false),
    });
  }
  async deleteActivity(
    input: PlanCommandInput & { activityId: unknown; confirmed: unknown },
  ): Promise<MutationResult> {
    const command = base(input, 'DELETE_ACTIVITY');
    if (input.confirmed !== true) return fail('VALIDATION_FAILED', 400);
    return this.write({ ...command, activityId: uuid(input.activityId), confirmed: true });
  }
  async reorderActivities(
    input: PlanCommandInput & { activityIds: unknown },
  ): Promise<MutationResult> {
    const command = base(input, 'REORDER_ACTIVITIES');
    if (!Array.isArray(input.activityIds)) return fail('VALIDATION_FAILED', 400);
    const activityIds = input.activityIds.map(uuid);
    if (new Set(activityIds).size !== activityIds.length) return fail('VALIDATION_FAILED', 400);
    return this.write({ ...command, activityIds });
  }
  async setActivityCompletion(
    input: PlanCommandInput & { activityId: unknown; status: unknown },
  ): Promise<MutationResult> {
    const command = base(input, 'SET_ACTIVITY_COMPLETION');
    if (input.status !== 'TODO' && input.status !== 'COMPLETED')
      return fail('VALIDATION_FAILED', 400);
    return this.write({ ...command, activityId: uuid(input.activityId), status: input.status });
  }
  private async write(input: NormalizedCommand): Promise<MutationResult> {
    const requestHash = planRequestHash(input);
    return this.database.withTransaction(async (client) => {
      await lockOperation(client, input.operationId);
      // Read permissions with a fresh snapshot after any concurrent editor/policy change
      // releases the Trip lock. A subquery in the locking statement can see stale grants.
      await client.query('SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
        input.tripId,
      ]);
      const access = await client.query<AccessRow>(`${ACCESS_SQL} FOR UPDATE OF m`, [
        input.tripId,
        input.actorUserId,
      ]);
      const trip = access.rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      const editor = isPlanEditor(trip.role, trip.plan_edit_policy, trip.selected_editor);
      if (input.command !== 'SET_ACTIVITY_COMPLETION' && !editor)
        return fail('PERMISSION_DENIED', 403);
      const receipt = await receiptById(client, input.operationId);
      if (receipt)
        return savedOutcome(
          verifyReceipt(receipt, {
            operationType: input.command,
            actorUserId: input.actorUserId,
            requestHash,
            tripId: input.tripId,
          }),
          input,
        );
      if (trip.archived_at !== null) return fail('STATE_CONFLICT', 409);
      if (trip.plan_version !== input.expectedPlanVersion)
        return fail('VERSION_CONFLICT', 409, {
          plan_version: trip.plan_version,
          export_revision: trip.export_revision,
        });
      await client.query('SET CONSTRAINTS uq_activities_2 IMMEDIATE');
      let activity = input.activityId
        ? await activityById(client, input.tripId, input.activityId)
        : undefined;
      const changes = new Map<string, PlanChange>();
      const change = (
        id: string,
        action: PlanChange['action'] = 'UPSERT',
        type: PlanChange['type'] = 'ACTIVITY',
      ) => changes.set(`${type}:${id}`, { type, id, action });
      const reorder = async (ids: string[]) => {
        for (const id of await writeOrder(client, input.tripId, ids)) change(id);
      };
      let action: string = input.command;
      let details: Record<string, unknown> = {};
      let ids: string[] = [];
      if (input.command !== 'SET_ACTIVITY_COMPLETION') {
        const list = await client.query<{ id: string }>(
          'SELECT id FROM activities WHERE trip_id=$1 ORDER BY position,id',
          [input.tripId],
        );
        ids = list.rows.map((row) => row.id);
      }
      if (input.fields) {
        const fields = input.fields;
        const merged = {
          ...(activity ? projectActivity(activity, trip.plan_version) : {}),
          ...fields,
        };
        validateTimes(merged.starts_at ?? null, merged.ends_at ?? null, trip);
        if (fields.selected_location_id) {
          const found = await client.query(
            'SELECT id FROM selected_locations WHERE id=$1 AND trip_id=$2',
            [fields.selected_location_id, input.tripId],
          );
          if (!found.rows[0]) return fail('VALIDATION_FAILED', 400);
        }
        const maxPosition = input.command === 'CREATE_ACTIVITY' ? ids.length : ids.length - 1;
        if (fields.position !== undefined && fields.position > maxPosition)
          return fail('VALIDATION_FAILED', 400);
        if (input.command === 'CREATE_ACTIVITY') {
          // Normalize any legacy gaps before using n as a temporary free position.
          await reorder(ids);
          const created = await client.query<ActivityRow>(
            `INSERT INTO activities(trip_id,title,activity_type,
            description,public_description,selected_location_id,starts_at,ends_at,position,source,created_by_user_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10) RETURNING ${ACTIVITY_COLUMNS}`,
            [
              input.tripId,
              fields.title,
              fields.activity_type,
              fields.description,
              fields.public_description,
              fields.selected_location_id,
              fields.starts_at,
              fields.ends_at,
              ids.length,
              input.actorUserId,
            ],
          );
          activity = created.rows[0];
          if (!activity) throw new Error('Activity insert returned no row');
          change(activity.id);
          await reorder(orderedIds(ids, activity.id, fields.position!));
          action = 'ACTIVITY_CREATED';
          details = { changed_fields: Object.keys(fields) };
        } else {
          const previous = projectActivity(activity!, trip.plan_version);
          const changedFields = (Object.keys(fields) as (keyof Fields)[]).filter(
            (key) => fields[key] !== previous[key],
          );
          if (changedFields.length) {
            await client.query(
              `UPDATE activities SET
              title=CASE WHEN $3 THEN $4 ELSE title END,
              activity_type=CASE WHEN $5 THEN $6 ELSE activity_type END,
              description=CASE WHEN $7 THEN $8 ELSE description END,
              public_description=CASE WHEN $9 THEN $10 ELSE public_description END,
              selected_location_id=CASE WHEN $11 THEN $12::uuid ELSE selected_location_id END,
              starts_at=CASE WHEN $13 THEN $14::timestamptz ELSE starts_at END,
              ends_at=CASE WHEN $15 THEN $16::timestamptz ELSE ends_at END,updated_at=now()
              WHERE id=$1 AND trip_id=$2`,
              [
                activity!.id,
                input.tripId,
                ...(
                  [
                    'title',
                    'activity_type',
                    'description',
                    'public_description',
                    'selected_location_id',
                    'starts_at',
                    'ends_at',
                  ] as const
                ).flatMap((key) => [Object.hasOwn(fields, key), fields[key] ?? null]),
              ],
            );
            change(activity!.id);
          }
          if (fields.position !== undefined)
            await reorder(orderedIds(ids, activity!.id, fields.position));
          action = 'ACTIVITY_UPDATED';
          details = { changed_fields: changedFields };
        }
      } else if (input.command === 'DELETE_ACTIVITY') {
        const deletedDress = await client.query<{ id: string }>(
          `DELETE FROM dress_codes
          WHERE trip_id=$1 AND scope_type='ACTIVITY' AND activity_id=$2 RETURNING id`,
          [input.tripId, activity!.id],
        );
        for (const row of deletedDress.rows) change(row.id, 'DELETE', 'DRESS_CODE');
        const deleted = await client.query<ActivityRow>(
          `DELETE FROM activities WHERE id=$1 AND trip_id=$2
          RETURNING ${ACTIVITY_COLUMNS}`,
          [activity!.id, input.tripId],
        );
        details = {
          activity: projectActivity(deleted.rows[0]!, trip.plan_version),
          deleted_dress_code_ids: deletedDress.rows.map((row) => row.id),
        };
        change(activity!.id, 'DELETE');
        await reorder(ids.filter((id) => id !== activity!.id));
        activity = undefined;
        action = 'ACTIVITY_DELETED';
      } else if (input.command === 'REORDER_ACTIVITIES') {
        validatePermutation(ids, input.activityIds!);
        await reorder(input.activityIds!);
        action = 'ACTIVITIES_REORDERED';
        details = { activity_ids: input.activityIds };
      } else if (input.command === 'SET_ACTIVITY_COMPLETION') {
        if (
          input.status === 'TODO' &&
          !editor &&
          activity!.completed_by_user_id !== input.actorUserId
        )
          return fail('PERMISSION_DENIED', 403);
        if (activity!.status !== input.status) {
          await client.query(
            `UPDATE activities SET status=$3::text,
            completed_by_user_id=CASE WHEN $3::text='COMPLETED' THEN $4::uuid ELSE NULL END,
            completed_at=CASE WHEN $3::text='COMPLETED' THEN now() ELSE NULL END,updated_at=now()
            WHERE id=$1 AND trip_id=$2`,
            [activity!.id, input.tripId, input.status, input.actorUserId],
          );
          change(activity!.id);
        }
        action = input.status === 'COMPLETED' ? 'ACTIVITY_COMPLETED' : 'ACTIVITY_REOPENED';
      }
      let version: PlanVersion = {
        trip_id: input.tripId,
        plan_version: trip.plan_version,
        export_revision: trip.export_revision,
      };
      if (changes.size) {
        if (trip.plan_version >= MAX_INT32 || trip.export_revision >= MAX_INT32)
          return fail('STATE_CONFLICT', 409);
        const revised = await client.query<PlanVersion>(
          `UPDATE trips SET plan_version=plan_version+1,
          export_revision=export_revision+1,updated_at=now() WHERE id=$1
          RETURNING id AS trip_id,plan_version,export_revision`,
          [input.tripId],
        );
        version = revised.rows[0]!;
        await client.query(
          `INSERT INTO trip_audit_logs(trip_id,actor_user_id,action,entity_type,
          entity_id,from_version,to_version,details,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            input.tripId,
            input.actorUserId,
            action,
            input.command === 'REORDER_ACTIVITIES' ? 'PLAN' : 'ACTIVITY',
            input.activityId ?? activity?.id ?? input.tripId,
            trip.plan_version,
            version.plan_version,
            JSON.stringify(details),
            input.correlationId,
          ],
        );
        await insertPlanUpdated(client, {
          ...input,
          planVersion: version.plan_version,
          changes: [...changes.values()],
        });
      }
      const outcome: MutationResult = { version };
      if (activity)
        outcome.activity = projectActivity(
          await activityById(client, input.tripId, activity.id),
          version.plan_version,
        );
      await insertReceipt(client, {
        ...input,
        operationType: input.command,
        requestHash,
        contextRevision: version.plan_version,
        outcome,
        commandPayload: commandPayload(input),
      });
      return outcome;
    });
  }
}
