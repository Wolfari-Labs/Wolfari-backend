import { Injectable } from '@nestjs/common';
import { isCalendarDate } from '@wolfari/common';
import { DatabaseProvider } from '@wolfari/database';
import {
  digest,
  fail,
  instant,
  insertReceipt,
  lockOperation,
  MAX_INT32,
  positiveRevision,
  receiptById,
  uuid,
  verifyReceipt,
} from '../trip-common';
import {
  ACCESS_SQL,
  projectLocation,
  type LocationRow,
  projectDressCode,
  projectPackingItem,
  type AccessRow,
  type DressCodeRow,
  type PackingRow,
  type PlanVersion,
} from './plan.projection';
import { isPlanEditor } from './plan.service';
import { insertPlanUpdated } from './plan.events';

export type ItemKind = 'DRESS_CODE' | 'PACKING_ITEM' | 'SELECTED_LOCATION';
export type ItemAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'COMPLETE';
type Fields = Record<string, string | null>;
const dressFields = [
  'scope_type',
  'plan_date',
  'activity_id',
  'label',
  'description',
  'public_description',
];
const packingFields = [
  'name',
  'quantity',
  'unit',
  'note',
  'category',
  'assigned_member_id',
  'due_at',
];
const locationFields = ['name', 'address', 'latitude', 'longitude', 'attribution'];
const locationColumns = 'id,trip_id,name,address,latitude::text,longitude::text,provider,provider_place_id,source,opening_hours,fetched_at,metadata';
const dressColumns =
  "id,trip_id,scope_type,to_char(plan_date,'YYYY-MM-DD') AS plan_date,activity_id,label,description,public_description,reference_image_key,source";
const packingColumns =
  'id,trip_id,name,quantity::text,unit,note,category,assigned_member_id,due_at,status,source,completed_by_user_id,completed_at';

export function normalizeItemFields(kind: ItemKind, action: ItemAction, value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('VALIDATION_FAILED', 400);
  const input = value as Record<string, unknown>;
  const allowed =
    action === 'COMPLETE'
      ? ['status']
      : action === 'DELETE'
        ? []
        : kind === 'DRESS_CODE'
          ? dressFields
          : kind === 'SELECTED_LOCATION' ? locationFields : packingFields;
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    (action === 'UPDATE' && !Object.keys(input).length)
  )
    return fail('VALIDATION_FAILED', 400);
  const fields: Fields = {};
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) continue;
    const raw = input[key];
    if (key === 'attribution') {
      if (!Array.isArray(raw) || raw.length > 5 || raw.some(a => !a || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 500 || typeof a.url !== 'string' || a.url.length > 2000 || !/^https:\/\//.test(a.url))) return fail('VALIDATION_FAILED', 400);
      fields.metadata = JSON.stringify({ attribution: raw.map(a => ({ text: a.text.trim(), url: a.url })) });
      continue;
    }
    if (key === 'latitude' || key === 'longitude') {
      if (raw === null) { fields[key] = null; continue; }
      const limit = key === 'latitude' ? 90 : 180;
      if (typeof raw !== 'string' || !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(raw) || Math.abs(Number(raw)) > limit) return fail('VALIDATION_FAILED', 400);
      fields[key] = Number(raw).toFixed(6);
      continue;
    }
    if (raw === null && !['name', 'label', 'quantity', 'scope_type', 'status'].includes(key)) {
      fields[key] = null;
      continue;
    }
    if (typeof raw !== 'string' || raw.includes('\0')) return fail('VALIDATION_FAILED', 400);
    const text = raw.trim();
    const max =
      key === 'name'
        ? 200
        : key === 'label'
          ? 100
          : key === 'unit'
            ? 30
            : key === 'category'
              ? 80
              : 5000;
    if ([...text].length > max || (['name', 'label'].includes(key) && !text))
      return fail('VALIDATION_FAILED', 400);
    if (key === 'quantity') {
      if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0)
        return fail('VALIDATION_FAILED', 400);
      fields[key] = Number(text).toFixed(2);
    } else if (key === 'due_at') fields[key] = instant(text).toISOString();
    else if (key === 'activity_id' || key === 'assigned_member_id') fields[key] = uuid(text);
    else if (key === 'plan_date') {
      if (!isCalendarDate(text)) return fail('VALIDATION_FAILED', 400);
      fields[key] = text;
    } else fields[key] = text;
  }
  if (action === 'CREATE') {
    if (kind === 'DRESS_CODE') {
      if (!fields.label || !fields.scope_type) return fail('VALIDATION_FAILED', 400);
      for (const key of ['plan_date', 'activity_id', 'description', 'public_description'])
        fields[key] ??= null;
    } else if (kind === 'SELECTED_LOCATION') {
      if (!fields.name) return fail('VALIDATION_FAILED', 400);
      for (const key of ['address', 'latitude', 'longitude']) fields[key] ??= null;
    } else {
      if (!fields.name) return fail('VALIDATION_FAILED', 400);
      fields.quantity ??= '1.00';
      for (const key of ['unit', 'note', 'category', 'assigned_member_id', 'due_at'])
        fields[key] ??= null;
    }
  }
  if (fields.scope_type !== undefined && !['TRIP', 'DAY', 'ACTIVITY'].includes(fields.scope_type!))
    return fail('VALIDATION_FAILED', 400);
  if (action === 'COMPLETE' && !['TODO', 'COMPLETED'].includes(fields.status!))
    return fail('VALIDATION_FAILED', 400);
  return fields;
}

@Injectable()
export class PlanItemsService {
  constructor(private readonly database: DatabaseProvider) {}

  async mutate(
    raw: {
      actor_user_id?: unknown;
      operation_id?: unknown;
      trip_id?: unknown;
      expected_plan_version?: unknown;
      item_id?: unknown;
      entity_type?: unknown;
      action?: unknown;
      fields_json?: unknown;
    },
    correlationId: string,
  ) {
    const actor = uuid(raw.actor_user_id),
      operation = uuid(raw.operation_id),
      tripId = uuid(raw.trip_id);
    const expected = positiveRevision(raw.expected_plan_version);
    const kind = raw.entity_type as ItemKind,
      action = raw.action as ItemAction;
    if (
      !['DRESS_CODE', 'PACKING_ITEM', 'SELECTED_LOCATION'].includes(kind) ||
      !['CREATE', 'UPDATE', 'DELETE', 'COMPLETE'].includes(action) ||
      (kind !== 'PACKING_ITEM' && action === 'COMPLETE')
    )
      return fail('VALIDATION_FAILED', 400);
    const itemId = action === 'CREATE' ? undefined : uuid(raw.item_id);
    if (action === 'CREATE' && raw.item_id) return fail('VALIDATION_FAILED', 400);
    let decoded: unknown;
    try {
      if (typeof raw.fields_json !== 'string' || raw.fields_json.length > 24000) throw Error();
      decoded = JSON.parse(raw.fields_json);
    } catch {
      return fail('VALIDATION_FAILED', 400);
    }
    const fields = normalizeItemFields(kind, action, decoded);
    const operationType = `${action}_${kind}`;
    const requestHash = digest({ operationType, actor, tripId, itemId, expected, fields });
    const table = kind === 'DRESS_CODE' ? 'dress_codes' : kind === 'SELECTED_LOCATION' ? 'selected_locations' : 'packing_items';
    const columns = kind === 'DRESS_CODE' ? dressColumns : kind === 'SELECTED_LOCATION' ? locationColumns : packingColumns;
    return this.database.withTransaction(async (client) => {
      await lockOperation(client, operation);
      await client.query('SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
        tripId,
      ]);
      const access =
        (await client.query<AccessRow>(`${ACCESS_SQL} FOR UPDATE OF m`, [tripId, actor])).rows[0] ??
        fail('RESOURCE_NOT_FOUND', 404);
      const editor = isPlanEditor(access.role, access.plan_edit_policy, access.selected_editor);
      if (action !== 'COMPLETE' && !editor) return fail('PERMISSION_DENIED', 403);
      const saved = await receiptById(client, operation);
      if (saved)
        return verifyReceipt(saved, { operationType, actorUserId: actor, requestHash, tripId }) as {
          version: PlanVersion;
          item?: Record<string, unknown>;
        };
      if (access.archived_at !== null) return fail('STATE_CONFLICT', 409);
      if (access.plan_version !== expected)
        return fail('VERSION_CONFLICT', 409, { plan_version: access.plan_version });
      const existing = itemId
        ? ((
            await client.query<DressCodeRow & PackingRow & LocationRow>(
              `SELECT ${columns} FROM ${table} WHERE id=$1 AND trip_id=$2 FOR UPDATE`,
              [itemId, tripId],
            )
          ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404))
        : undefined;
      const merged = { ...existing, ...fields };
      if (kind === 'SELECTED_LOCATION') {
        if (action !== 'DELETE' && ((merged.latitude == null) !== (merged.longitude == null))) return fail('VALIDATION_FAILED', 400);
        if (action === 'DELETE' && (await client.query('SELECT id FROM activities WHERE trip_id=$1 AND selected_location_id=$2 LIMIT 1', [tripId, itemId])).rowCount) return fail('STATE_CONFLICT', 409);
      }
      if (action === 'COMPLETE') {
        if (
          !editor &&
          existing!.assigned_member_id &&
          existing!.assigned_member_id !== access.membership_id
        )
          return fail('PERMISSION_DENIED', 403);
        if (fields.status === 'TODO' && !editor && existing!.completed_by_user_id !== actor)
          return fail('PERMISSION_DENIED', 403);
      }
      if (kind === 'DRESS_CODE' && action !== 'DELETE') {
        const valid =
          (merged.scope_type === 'TRIP' && !merged.plan_date && !merged.activity_id) ||
          (merged.scope_type === 'DAY' && !!merged.plan_date && !merged.activity_id) ||
          (merged.scope_type === 'ACTIVITY' && !merged.plan_date && !!merged.activity_id);
        if (!valid) return fail('VALIDATION_FAILED', 400);
        if (merged.plan_date) {
          const day = await client.query<{ valid: boolean }>(
            `SELECT day_start < $3::timestamptz AND day_end > $4::timestamptz AND day_end > day_start AS valid FROM (SELECT $1::date::timestamp AT TIME ZONE $2 AS day_start,($1::date+1)::timestamp AT TIME ZONE $2 AS day_end) d`,
            [merged.plan_date, access.timezone, access.end_at, access.start_at],
          );
          if (!day.rows[0]?.valid) return fail('VALIDATION_FAILED', 400);
        }
        if (
          merged.activity_id &&
          !(
            await client.query('SELECT id FROM activities WHERE id=$1 AND trip_id=$2', [
              merged.activity_id,
              tripId,
            ])
          ).rowCount
        )
          return fail('VALIDATION_FAILED', 400);
      }
      if (
        kind === 'PACKING_ITEM' &&
        action !== 'DELETE' &&
        merged.assigned_member_id &&
        !(
          await client.query(
            'SELECT id FROM trip_members WHERE id=$1 AND trip_id=$2 AND left_at IS NULL',
            [merged.assigned_member_id, tripId],
          )
        ).rowCount
      )
        return fail('VALIDATION_FAILED', 400);
      if (access.plan_version >= MAX_INT32 || access.export_revision >= MAX_INT32)
        return fail('STATE_CONFLICT', 409);
      let id = itemId;
      if (action === 'CREATE') {
        const keys = Object.keys(fields);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ${table}(trip_id,created_by_user_id,${keys.join(',')}) VALUES($1,$2,${keys.map((_, i) => `$${i + 3}`).join(',')}) RETURNING id`,
          [tripId, actor, ...Object.values(fields)],
        );
        id = inserted.rows[0]!.id;
      } else if (action === 'DELETE')
        await client.query(`DELETE FROM ${table} WHERE id=$1 AND trip_id=$2`, [id, tripId]);
      else if (action === 'COMPLETE')
        await client.query(
          `UPDATE packing_items SET status=$3::text,completed_by_user_id=CASE WHEN $3::text='COMPLETED' THEN $4::uuid ELSE NULL END,completed_at=CASE WHEN $3::text='COMPLETED' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 AND trip_id=$2`,
          [id, tripId, fields.status, actor],
        );
      else {
        const keys = Object.keys(fields);
        await client.query(
          `UPDATE ${table} SET ${keys.map((key, i) => `${key}=$${i + 3}`).join(',')},updated_at=now() WHERE id=$1 AND trip_id=$2`,
          [id, tripId, ...Object.values(fields)],
        );
      }
      const version = (
        await client.query<PlanVersion>(
          'UPDATE trips SET plan_version=plan_version+1,export_revision=export_revision+1,updated_at=now() WHERE id=$1 RETURNING id AS trip_id,plan_version,export_revision',
          [tripId],
        )
      ).rows[0]!;
      let item: Record<string, unknown> | undefined;
      if (action !== 'DELETE') {
        const row = (
          await client.query<DressCodeRow & PackingRow & LocationRow>(
            `SELECT ${columns} FROM ${table} WHERE id=$1 AND trip_id=$2`,
            [id, tripId],
          )
        ).rows[0]!;
        item =
          kind === 'DRESS_CODE'
            ? projectDressCode(row, version.plan_version)
            : kind === 'SELECTED_LOCATION' ? projectLocation(row, version.plan_version) : projectPackingItem(row, version.plan_version);
      }
      await client.query(
        'INSERT INTO trip_audit_logs(trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,details,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
        [
          tripId,
          actor,
          operationType,
          kind,
          id,
          access.plan_version,
          version.plan_version,
          JSON.stringify({ changed_fields: Object.keys(fields) }),
          correlationId,
        ],
      );
      await insertPlanUpdated(client, {
        tripId,
        actorUserId: actor,
        operationId: operation,
        correlationId,
        planVersion: version.plan_version,
        changes: [{ type: kind, id: id!, action: action === 'DELETE' ? 'DELETE' : 'UPSERT' }],
      });
      const outcome = { version, ...(item ? { item } : {}) };
      await insertReceipt(client, {
        operationId: operation,
        tripId,
        operationType,
        actorUserId: actor,
        requestHash,
        contextRevision: version.plan_version,
        outcome,
        commandPayload: { itemId, fields, expected },
      });
      return outcome;
    });
  }
}
