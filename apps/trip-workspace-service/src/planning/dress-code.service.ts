import { Injectable } from '@nestjs/common';
import { isCalendarDate } from '@wolfari/common';
import { DatabaseProvider } from '@wolfari/database';
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
  type QueryClient,
} from '../trip-common';
import { insertPlanUpdated } from './plan.events';
import {
  ACCESS_SQL,
  projectDressCode,
  type AccessRow,
  type DressCodeRow,
  type PlanVersion,
} from './plan.projection';
import { isPlanEditor, type PlanCommandInput } from './plan.service';

/** FR-PL03 / API051-053: manual dress code writes for Plan Editors. */
export type DressScope = DressCodeRow['scope_type'];
export type DressCodeView = ReturnType<typeof projectDressCode>;
export interface DressCodeFields {
  scope_type?: DressScope;
  plan_date?: string | null;
  activity_id?: string | null;
  label?: string;
  description?: string | null;
  public_description?: string | null;
}
export interface DressCodeResult {
  version: PlanVersion;
  dress_code?: DressCodeView;
}
type Command = 'CREATE_DRESS_CODE' | 'UPDATE_DRESS_CODE' | 'DELETE_DRESS_CODE';
type NormalizedCommand = {
  command: Command;
  operationId: string;
  actorUserId: string;
  tripId: string;
  correlationId: string;
  expectedPlanVersion: number;
  dressCodeId?: string;
  fields?: DressCodeFields;
};

export const DRESS_LABEL_MAX = 100;
export const DRESS_TEXT_MAX = 10_000;
const SCOPES: readonly DressScope[] = ['TRIP', 'DAY', 'ACTIVITY'];
const FIELD_NAMES = [
  'scope_type',
  'plan_date',
  'activity_id',
  'label',
  'description',
  'public_description',
] as const;
const DRESS_COLUMNS = `id,trip_id,scope_type,to_char(plan_date,'YYYY-MM-DD') AS plan_date,
  activity_id,label,description,public_description,source`;

/** Blank free text is stored as "no description" so readers need one empty state. */
function freeText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || [...value].length > DRESS_TEXT_MAX)
    return fail('VALIDATION_FAILED', 400);
  return value.trim() ? value.trim() : null;
}

/** ERD ck_dress_codes_1: exactly one scope, with only that scope's reference set. */
export function assertDressScope(
  value: Pick<DressCodeFields, 'scope_type' | 'plan_date' | 'activity_id'>,
): void {
  const date = value.plan_date ?? null,
    activity = value.activity_id ?? null;
  const valid =
    (value.scope_type === 'TRIP' && date === null && activity === null) ||
    (value.scope_type === 'DAY' && date !== null && activity === null) ||
    (value.scope_type === 'ACTIVITY' && date === null && activity !== null);
  if (!valid) return fail('VALIDATION_FAILED', 400);
}

export function normalizeDressCodeFields(value: unknown, create: boolean): DressCodeFields {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.keys(value).length ||
    Object.keys(value).some((key) => !(FIELD_NAMES as readonly string[]).includes(key))
  )
    return fail('VALIDATION_FAILED', 400);
  const input = value as Record<string, unknown>;
  const fields: DressCodeFields = {};
  if (create || Object.hasOwn(input, 'scope_type')) {
    if (!SCOPES.includes(input.scope_type as DressScope)) return fail('VALIDATION_FAILED', 400);
    fields.scope_type = input.scope_type as DressScope;
  }
  if (Object.hasOwn(input, 'plan_date')) {
    if (input.plan_date !== null && !isCalendarDate(input.plan_date))
      return fail('VALIDATION_FAILED', 400);
    fields.plan_date = input.plan_date;
  } else if (create) fields.plan_date = null;
  if (Object.hasOwn(input, 'activity_id'))
    fields.activity_id = input.activity_id === null ? null : uuid(input.activity_id);
  else if (create) fields.activity_id = null;
  if (create || Object.hasOwn(input, 'label')) {
    if (
      typeof input.label !== 'string' ||
      !input.label.trim() ||
      [...input.label.trim()].length > DRESS_LABEL_MAX
    )
      return fail('VALIDATION_FAILED', 400);
    fields.label = input.label.trim();
  }
  for (const key of ['description', 'public_description'] as const) {
    if (Object.hasOwn(input, key)) fields[key] = freeText(input[key]);
    else if (create) fields[key] = null;
  }
  if (create) assertDressScope(fields);
  return fields;
}

function commandPayload(input: NormalizedCommand) {
  return {
    expected_plan_version: input.expectedPlanVersion,
    ...(input.fields ? { fields: input.fields } : {}),
  };
}
export function dressCodeRequestHash(input: NormalizedCommand): string {
  return digest({
    actor_user_id: input.actorUserId,
    command: input.command,
    trip_id: input.tripId,
    ...(input.dressCodeId ? { dress_code_id: input.dressCodeId } : {}),
    payload: commandPayload(input),
  });
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
function savedOutcome(value: unknown, input: NormalizedCommand): DressCodeResult {
  const saved = value as DressCodeResult | null;
  if (
    !saved ||
    typeof saved !== 'object' ||
    saved.version?.trip_id !== input.tripId ||
    !Number.isInteger(saved.version.plan_version) ||
    !Number.isInteger(saved.version.export_revision)
  )
    throw new Error('Invalid Plan receipt');
  if (
    input.command !== 'DELETE_DRESS_CODE' &&
    (!saved.dress_code ||
      saved.dress_code.trip_id !== input.tripId ||
      (input.dressCodeId && saved.dress_code.id !== input.dressCodeId))
  )
    throw new Error('Invalid dress code receipt');
  return saved;
}
async function dressCodeById(client: QueryClient, tripId: string, id: string) {
  const result = await client.query<DressCodeRow>(
    `SELECT ${DRESS_COLUMNS} FROM dress_codes WHERE id=$1 AND trip_id=$2 FOR UPDATE`,
    [id, tripId],
  );
  return result.rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
}
/** AC-PL03: a DAY dress code must fall on a calendar day the Trip covers in its own timezone. */
async function assertDayInsideTrip(client: QueryClient, date: string, trip: AccessRow) {
  const bounds = await client.query<{ valid: boolean }>(
    `SELECT day_start < $3::timestamptz AND day_end > $4::timestamptz
      AND day_end > day_start AS valid
     FROM (SELECT $1::date::timestamp AT TIME ZONE $2 AS day_start,
       ($1::date + 1)::timestamp AT TIME ZONE $2 AS day_end) d`,
    [date, trip.timezone, trip.end_at, trip.start_at],
  );
  if (!bounds.rows[0]?.valid) return fail('VALIDATION_FAILED', 400);
}

@Injectable()
export class DressCodeService {
  constructor(private readonly database: DatabaseProvider) {}

  async createDressCode(input: PlanCommandInput & { fields: unknown }): Promise<DressCodeResult> {
    return this.write({
      ...base(input, 'CREATE_DRESS_CODE'),
      fields: normalizeDressCodeFields(input.fields, true),
    });
  }
  async updateDressCode(
    input: PlanCommandInput & { dressCodeId: unknown; fields: unknown },
  ): Promise<DressCodeResult> {
    return this.write({
      ...base(input, 'UPDATE_DRESS_CODE'),
      dressCodeId: uuid(input.dressCodeId),
      fields: normalizeDressCodeFields(input.fields, false),
    });
  }
  async deleteDressCode(
    input: PlanCommandInput & { dressCodeId: unknown },
  ): Promise<DressCodeResult> {
    return this.write({
      ...base(input, 'DELETE_DRESS_CODE'),
      dressCodeId: uuid(input.dressCodeId),
    });
  }

  private async write(input: NormalizedCommand): Promise<DressCodeResult> {
    const requestHash = dressCodeRequestHash(input);
    return this.database.withTransaction(async (client) => {
      await lockOperation(client, input.operationId);
      // Same locking order as activity writes: Trip row first, then a fresh permission read.
      await client.query('SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
        input.tripId,
      ]);
      const access = await client.query<AccessRow>(`${ACCESS_SQL} FOR UPDATE OF m`, [
        input.tripId,
        input.actorUserId,
      ]);
      const trip = access.rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      if (!isPlanEditor(trip.role, trip.plan_edit_policy, trip.selected_editor))
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
      const existing = input.dressCodeId
        ? await dressCodeById(client, input.tripId, input.dressCodeId)
        : undefined;
      let changed = false;
      let saved: DressCodeRow | undefined;
      let action = 'DRESS_CODE_DELETED';
      let details: Record<string, unknown> = {};
      if (input.fields) {
        const fields = input.fields;
        const merged = { ...existing, ...fields };
        assertDressScope(merged);
        // Re-check references only when the write sets them; stored rows are already valid.
        if (merged.scope_type === 'DAY' && (!existing || fields.plan_date !== undefined))
          await assertDayInsideTrip(client, merged.plan_date!, trip);
        if (merged.scope_type === 'ACTIVITY' && (!existing || fields.activity_id !== undefined)) {
          const found = await client.query(
            'SELECT id FROM activities WHERE id=$1 AND trip_id=$2 FOR SHARE',
            [merged.activity_id, input.tripId],
          );
          if (!found.rows[0]) return fail('VALIDATION_FAILED', 400);
        }
        if (!existing) {
          const created = await client.query<DressCodeRow>(
            `INSERT INTO dress_codes(trip_id,scope_type,plan_date,activity_id,label,description,
              public_description,source,created_by_user_id)
            VALUES($1,$2,$3::date,$4,$5,$6,$7,'MANUAL',$8) RETURNING ${DRESS_COLUMNS}`,
            [
              input.tripId,
              fields.scope_type,
              fields.plan_date,
              fields.activity_id,
              fields.label,
              fields.description,
              fields.public_description,
              input.actorUserId,
            ],
          );
          saved = created.rows[0];
          if (!saved) throw new Error('Dress code insert returned no row');
          changed = true;
          action = 'DRESS_CODE_CREATED';
          details = { changed_fields: Object.keys(fields) };
        } else {
          const changedFields = FIELD_NAMES.filter(
            (key) => Object.hasOwn(fields, key) && fields[key] !== existing[key],
          );
          saved = existing;
          if (changedFields.length) {
            const updated = await client.query<DressCodeRow>(
              `UPDATE dress_codes SET scope_type=$3,plan_date=$4::date,activity_id=$5,label=$6,
                description=$7,public_description=$8,updated_at=now()
              WHERE id=$1 AND trip_id=$2 RETURNING ${DRESS_COLUMNS}`,
              [
                existing.id,
                input.tripId,
                merged.scope_type,
                merged.plan_date,
                merged.activity_id,
                merged.label,
                merged.description,
                merged.public_description,
              ],
            );
            saved = updated.rows[0]!;
            changed = true;
          }
          action = 'DRESS_CODE_UPDATED';
          details = { changed_fields: changedFields };
        }
      } else {
        await client.query('DELETE FROM dress_codes WHERE id=$1 AND trip_id=$2', [
          existing!.id,
          input.tripId,
        ]);
        changed = true;
        details = { dress_code: projectDressCode(existing!, trip.plan_version) };
      }
      let version: PlanVersion = {
        trip_id: input.tripId,
        plan_version: trip.plan_version,
        export_revision: trip.export_revision,
      };
      const entityId = saved?.id ?? existing!.id;
      if (changed) {
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
          entity_id,from_version,to_version,details,correlation_id)
          VALUES($1,$2,$3,'DRESS_CODE',$4,$5,$6,$7::jsonb,$8)`,
          [
            input.tripId,
            input.actorUserId,
            action,
            entityId,
            trip.plan_version,
            version.plan_version,
            JSON.stringify(details),
            input.correlationId,
          ],
        );
        await insertPlanUpdated(client, {
          ...input,
          planVersion: version.plan_version,
          changes: [{ type: 'DRESS_CODE', id: entityId, action: saved ? 'UPSERT' : 'DELETE' }],
        });
      }
      const outcome: DressCodeResult = { version };
      if (saved) outcome.dress_code = projectDressCode(saved, version.plan_version);
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
