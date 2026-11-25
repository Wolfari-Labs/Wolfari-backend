import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { TravelV1, TripV1 } from '@wolfari/contracts/grpc';
import {
  digest,
  fail,
  iso,
  insertReceipt,
  lockOperation,
  MAX_INT32,
  positiveRevision,
  receiptById,
  uuid,
  verifyReceipt,
  type QueryClient,
} from '../trip-common';
import { ACCESS_SQL, readPlanLists, type AccessRow } from './plan.projection';
import { isPlanEditor } from './plan.service';
import { insertPlanUpdated, type PlanChange } from './plan.events';
import { TravelClient } from './travel.client';

/**
 * FR-DS01: every member may preview a recommendation; only a Plan editor applies it.
 * Travel computes, Trip owns the receipt: apply reads the stored proposal, never the client's
 * copy, refuses it after 30 minutes or once the Plan moved on, and is idempotent per key.
 */
export const RECOMMENDATION_TTL_MS = 30 * 60_000;
const TYPES = ['PACKING', 'DRESS_CODE', 'ALL'] as const;
type RecType = (typeof TYPES)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 50;

export type StoredItem = {
  id: string;
  kind: 'PACKING' | 'DRESS_CODE';
  packing_item?: { name: string; quantity: string; unit?: string; category?: string };
  dress_code?: { label: string; description?: string; activity_id: string };
  date?: string;
  reasons: string[];
  rule_ids: string[];
  warnings: string[];
};
export type StoredSource = {
  provider: string;
  fetched_at: string | null;
  stale: boolean;
  is_mock: boolean;
  attribution: { text: string; url: string }[];
};
type Stored = {
  items: StoredItem[];
  warnings: string[];
  sources: StoredSource[];
  applied?: unknown;
};
type ReceiptRow = {
  id: string;
  trip_id: string;
  rule_version: string;
  base_plan_version: number;
  proposal: Stored | string;
  apply_request_id: string | null;
  status: 'PREVIEWED' | 'APPLIED' | 'REJECTED' | 'EXPIRED';
  applied_plan_version: number | null;
  created_at: Date | string;
  expires_at: Date | string;
  recommendation_type: string;
};

const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const tsIso = (t: { seconds?: string } | undefined) =>
  t?.seconds ? new Date(Number(t.seconds) * 1000).toISOString() : null;
const toTs = (value: string | Date | null) =>
  value === null
    ? undefined
    : { seconds: String(Math.floor(new Date(value).getTime() / 1000)), nanos: 0 };

/** Travel's proposal → the allowlisted rows Trip stores and later applies. Bad rows are dropped. */
export function storedItems(
  proposal: TravelV1.ProposalItem[] | undefined,
  activityIds: ReadonlySet<string>,
): StoredItem[] {
  return (proposal ?? []).slice(0, MAX_ITEMS).flatMap((p): StoredItem[] => {
    const id = text(p.id, 64);
    if (!id) return [];
    const base = {
      id,
      reasons: (p.reason ?? '')
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean)
        .slice(0, 4),
      rule_ids: (p.rule_ids ?? []).filter((r) => /^[A-Z]{2}-[A-Z0-9-]{1,30}$/.test(r)).slice(0, 8),
      warnings: (p.warnings ?? []).filter((w) => /^[A-Z_]{3,40}$/.test(w)).slice(0, 4),
    };
    if (p.packing_item) {
      const name = text(p.packing_item.name, 200);
      const quantity = /^\d{1,8}(\.\d{1,2})?$/.test(p.packing_item.quantity ?? '')
        ? p.packing_item.quantity!
        : '1';
      if (!name) return [];
      const unit = text(p.packing_item.unit, 30),
        category = text(p.packing_item.category, 80);
      return [
        {
          ...base,
          kind: 'PACKING',
          packing_item: {
            name,
            quantity,
            ...(unit ? { unit } : {}),
            ...(category ? { category } : {}),
          },
        },
      ];
    }
    if (p.dress_code) {
      const label = text(p.dress_code.label, 100),
        activity = p.dress_code.activity_id ?? '';
      if (!label || !activityIds.has(activity)) return [];
      const description = text(p.dress_code.description, 2000);
      const date = DATE.test(p.dress_code.plan_date ?? '') ? p.dress_code.plan_date : undefined;
      return [
        {
          ...base,
          kind: 'DRESS_CODE',
          dress_code: { label, activity_id: activity, ...(description ? { description } : {}) },
          ...(date ? { date } : {}),
        },
      ];
    }
    return [];
  });
}

function sources(meta: TravelV1.ProviderMetadata[] | undefined): StoredSource[] {
  return (meta ?? []).slice(0, 8).map((m) => ({
    provider: text(m.provider, 40) ?? 'UNKNOWN',
    fetched_at: tsIso(m.fetched_at),
    stale: m.stale === true,
    is_mock: m.is_mock === true,
    attribution: (m.attribution ?? [])
      .filter((a) => typeof a.url === 'string' && /^https:\/\//.test(a.url))
      .slice(0, 2)
      .map((a) => ({ text: text(a.text, 120) ?? '', url: a.url! })),
  }));
}

/** Public JSON for the gateway and clients. */
export function projectRecommendation(row: ReceiptRow, canApply: boolean) {
  const stored = (
    typeof row.proposal === 'string' ? JSON.parse(row.proposal) : row.proposal
  ) as Stored;
  const expired = row.status === 'PREVIEWED' && new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: row.id,
    trip_id: row.trip_id,
    type: row.recommendation_type,
    status: expired ? 'EXPIRED' : row.status,
    rule_version: row.rule_version,
    base_plan_version: row.base_plan_version,
    applied_plan_version: row.applied_plan_version,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    can_apply: canApply && row.status === 'PREVIEWED' && !expired,
    items: stored.items,
    warnings: stored.warnings,
    sources: stored.sources,
    ...(stored.applied ? { applied: stored.applied } : {}),
  };
}

const RECEIPT_COLUMNS =
  'id,trip_id,rule_version,base_plan_version,proposal,apply_request_id,status,applied_plan_version,created_at,expires_at,recommendation_type';

@Injectable()
export class RecommendationService {
  constructor(
    private readonly database: DatabaseProvider,
    private readonly travel: TravelClient,
  ) {}

  private async access(client: QueryClient, tripId: string, actor: string, lock = false) {
    return (
      (
        await client.query<AccessRow>(`${ACCESS_SQL}${lock ? ' FOR UPDATE OF m' : ''}`, [
          tripId,
          actor,
        ])
      ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404)
    );
  }

  async preview(
    raw: {
      actor_user_id?: unknown;
      trip_id?: unknown;
      type?: unknown;
      date?: unknown;
      activity_ids?: unknown;
    },
    correlationId: string,
  ) {
    const actor = uuid(raw.actor_user_id),
      tripId = uuid(raw.trip_id);
    const type = raw.type as RecType;
    if (!TYPES.includes(type)) return fail('VALIDATION_FAILED', 400);
    const date = raw.date === undefined || raw.date === '' ? undefined : String(raw.date);
    if (date !== undefined && !DATE.test(date)) return fail('VALIDATION_FAILED', 400);
    const activityIds = Array.isArray(raw.activity_ids) ? raw.activity_ids.map((v) => uuid(v)) : [];
    if (activityIds.length > 100) return fail('VALIDATION_FAILED', 400);
    if (!this.travel.configured) return fail('SERVICE_UNAVAILABLE', 503);

    // Read the Plan once, consistently, outside the slow provider call.
    const snapshot = await this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const access = await this.access(client, tripId, actor);
      const lists = await readPlanLists(client, tripId, access.plan_version);
      return { access, lists };
    });
    const { access, lists } = snapshot;
    const plan: TripV1.PlanSnapshot = {
      trip_id: tripId,
      plan_version: access.plan_version,
      export_revision: access.export_revision,
      timezone: access.timezone,
      start_at: toTs(access.start_at as Date | string),
      end_at: toTs(access.end_at as Date | string),
      activities: lists.activities.map((a) => ({
        id: a.id,
        title: a.title,
        activity_type: a.activity_type,
        selected_location_id: a.selected_location_id ?? undefined,
        starts_at: toTs(a.starts_at),
        ends_at: toTs(a.ends_at),
        position: a.position,
        ...(a.scheduled_date ? { scheduled_date: a.scheduled_date } : {}),
      })),
      selected_locations: lists.selected_locations
        .filter((l) => l.latitude !== null && l.longitude !== null)
        .map((l) => ({
          id: l.id,
          name: l.name,
          coordinates: { latitude: Number(l.latitude), longitude: Number(l.longitude) },
        })),
      dress_codes: lists.dress_codes.map((d) => ({
        id: d.id,
        label: d.label,
        activity_id: d.activity_id ?? undefined,
        source:
          d.source === 'DSS'
            ? TripV1.EntitySource.ENTITY_SOURCE_DSS
            : TripV1.EntitySource.ENTITY_SOURCE_MANUAL,
      })),
      packing_items: lists.packing_items.map((p) => ({
        id: p.id,
        name: p.name,
        quantity: p.quantity,
      })),
    };
    let result: TravelV1.GetRecommendationResponse;
    try {
      result = await this.travel.recommend(
        { plan, type, scope: { ...(date ? { date } : {}), activity_ids: activityIds } },
        correlationId,
      );
    } catch {
      return fail('SERVICE_UNAVAILABLE', 503);
    }
    const known = new Set(lists.activities.map((a) => a.id));
    const stored: Stored = {
      items: storedItems(result.proposal, known),
      warnings: (result.warnings ?? []).filter((w) => /^[A-Z_]{3,40}$/.test(w)).slice(0, 8),
      sources: sources(result.provider_sources),
    };
    const ruleVersion = text(result.rule_version, 40) ?? 'unknown';
    const inputHash = /^[0-9a-f]{64}$/.test(result.input_hash ?? '')
      ? result.input_hash!
      : digest(stored);
    const row = await this.database.withTransaction(async (client) => {
      // Lazy expiry keeps the table honest without a separate job.
      await client.query(
        "UPDATE recommendation_receipts SET status='EXPIRED' WHERE trip_id=$1 AND status='PREVIEWED' AND expires_at<=now()",
        [tripId],
      );
      return (
        await client.query<ReceiptRow>(
          `INSERT INTO recommendation_receipts(trip_id,requested_by_user_id,rule_version,base_plan_version,proposal,status,input_hash,recommendation_type,expires_at)
           VALUES($1,$2,$3,$4,$5::jsonb,'PREVIEWED',$6,$7,now()+($8::text||' milliseconds')::interval) RETURNING ${RECEIPT_COLUMNS}`,
          [
            tripId,
            actor,
            ruleVersion,
            access.plan_version,
            JSON.stringify(stored),
            inputHash,
            type,
            String(RECOMMENDATION_TTL_MS),
          ],
        )
      ).rows[0]!;
    });
    const editor =
      access.archived_at === null &&
      isPlanEditor(access.role, access.plan_edit_policy, access.selected_editor);
    return projectRecommendation(row, editor);
  }

  async apply(
    raw: {
      actor_user_id?: unknown;
      recommendation_id?: unknown;
      apply_request_id?: unknown;
      item_ids?: unknown;
      expected_plan_version?: unknown;
    },
    correlationId: string,
  ) {
    const actor = uuid(raw.actor_user_id),
      recommendationId = uuid(raw.recommendation_id),
      operation = uuid(raw.apply_request_id);
    const expected = positiveRevision(raw.expected_plan_version);
    const itemIds = Array.isArray(raw.item_ids)
      ? [...new Set(raw.item_ids.map((v) => String(v)))]
      : [];
    if (
      !itemIds.length ||
      itemIds.length > MAX_ITEMS ||
      itemIds.some((v) => !/^[0-9a-f]{8,64}$/.test(v))
    )
      return fail('VALIDATION_FAILED', 400);
    const operationType = 'APPLY_RECOMMENDATION';
    const requestHash = digest({
      operationType,
      actor,
      recommendationId,
      expected,
      itemIds: [...itemIds].sort(),
    });
    return this.database.withTransaction(async (client) => {
      await lockOperation(client, operation);
      const receipt =
        (
          await client.query<ReceiptRow>(
            `SELECT ${RECEIPT_COLUMNS} FROM recommendation_receipts WHERE id=$1`,
            [recommendationId],
          )
        ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      const tripId = receipt.trip_id;
      await client.query('SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
        tripId,
      ]);
      const access = await this.access(client, tripId, actor, true);
      if (!isPlanEditor(access.role, access.plan_edit_policy, access.selected_editor))
        return fail('PERMISSION_DENIED', 403);
      // The same key again returns the first result instead of a second set of items.
      const saved = await receiptById(client, operation);
      if (saved) {
        verifyReceipt(saved, { operationType, actorUserId: actor, requestHash, tripId });
        const again = (
          await client.query<ReceiptRow>(
            `SELECT ${RECEIPT_COLUMNS} FROM recommendation_receipts WHERE id=$1`,
            [recommendationId],
          )
        ).rows[0]!;
        return projectRecommendation(again, true);
      }
      if (access.archived_at !== null) return fail('STATE_CONFLICT', 409);
      const locked = (
        await client.query<ReceiptRow>(
          `SELECT ${RECEIPT_COLUMNS} FROM recommendation_receipts WHERE id=$1 FOR UPDATE`,
          [recommendationId],
        )
      ).rows[0]!;
      if (locked.status !== 'PREVIEWED')
        return fail('STATE_CONFLICT', 409, { reason: locked.status });
      if (new Date(locked.expires_at).getTime() <= Date.now()) {
        await client.query("UPDATE recommendation_receipts SET status='EXPIRED' WHERE id=$1", [
          recommendationId,
        ]);
        return fail('STATE_CONFLICT', 409, { reason: 'EXPIRED' });
      }
      if (access.plan_version !== locked.base_plan_version || access.plan_version !== expected)
        return fail('VERSION_CONFLICT', 409, { plan_version: access.plan_version });
      if (access.plan_version >= MAX_INT32 || access.export_revision >= MAX_INT32)
        return fail('STATE_CONFLICT', 409);
      const stored = (
        typeof locked.proposal === 'string' ? JSON.parse(locked.proposal) : locked.proposal
      ) as Stored;
      const chosen = stored.items.filter((i) => itemIds.includes(i.id));
      if (chosen.length !== itemIds.length) return fail('VALIDATION_FAILED', 400);

      // Re-check against the Plan as it is now: no duplicate names, no dress code for a gone activity.
      const names = new Set(
        (
          await client.query<{ key: string }>(
            "SELECT lower(regexp_replace(trim(name),'\\s+',' ','g')) AS key FROM packing_items WHERE trip_id=$1",
            [tripId],
          )
        ).rows.map((r) => r.key),
      );
      const activities = new Set(
        (
          await client.query<{ id: string }>('SELECT id FROM activities WHERE trip_id=$1', [tripId])
        ).rows.map((r) => r.id),
      );
      const created: { item_id: string; entity_type: 'PACKING_ITEM' | 'DRESS_CODE'; id: string }[] =
        [];
      const skipped: { item_id: string; reason: string }[] = [];
      const changes: PlanChange[] = [];
      for (const item of chosen) {
        if (item.packing_item) {
          const key = item.packing_item.name.trim().replace(/\s+/g, ' ').toLowerCase();
          if (names.has(key)) {
            skipped.push({ item_id: item.id, reason: 'ALREADY_IN_PLAN' });
            continue;
          }
          names.add(key);
          const id = (
            await client.query<{ id: string }>(
              "INSERT INTO packing_items(trip_id,created_by_user_id,name,quantity,unit,category,source) VALUES($1,$2,$3,$4,$5,$6,'DSS') RETURNING id",
              [
                tripId,
                actor,
                item.packing_item.name,
                item.packing_item.quantity,
                item.packing_item.unit ?? null,
                item.packing_item.category ?? null,
              ],
            )
          ).rows[0]!.id;
          created.push({ item_id: item.id, entity_type: 'PACKING_ITEM', id });
          changes.push({ type: 'PACKING_ITEM', id, action: 'UPSERT' });
        } else if (item.dress_code) {
          if (!activities.has(item.dress_code.activity_id)) {
            skipped.push({ item_id: item.id, reason: 'ACTIVITY_REMOVED' });
            continue;
          }
          const id = (
            await client.query<{ id: string }>(
              "INSERT INTO dress_codes(trip_id,created_by_user_id,scope_type,activity_id,label,description,source) VALUES($1,$2,'ACTIVITY',$3,$4,$5,'DSS') RETURNING id",
              [
                tripId,
                actor,
                item.dress_code.activity_id,
                item.dress_code.label,
                item.dress_code.description ?? null,
              ],
            )
          ).rows[0]!.id;
          created.push({ item_id: item.id, entity_type: 'DRESS_CODE', id });
          changes.push({ type: 'DRESS_CODE', id, action: 'UPSERT' });
        }
      }
      let planVersion = access.plan_version;
      if (created.length) {
        // One apply = one Plan version, however many items it adds.
        planVersion = (
          await client.query<{ plan_version: number }>(
            'UPDATE trips SET plan_version=plan_version+1,export_revision=export_revision+1,updated_at=now() WHERE id=$1 RETURNING plan_version',
            [tripId],
          )
        ).rows[0]!.plan_version;
        await client.query(
          'INSERT INTO trip_audit_logs(trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,details,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
          [
            tripId,
            actor,
            operationType,
            'RECOMMENDATION',
            recommendationId,
            access.plan_version,
            planVersion,
            JSON.stringify({
              rule_version: locked.rule_version,
              created: created.map((c) => ({ entity_type: c.entity_type, id: c.id })),
            }),
            correlationId,
          ],
        );
        await insertPlanUpdated(client, {
          tripId,
          actorUserId: actor,
          operationId: operation,
          correlationId,
          planVersion,
          changes,
        });
      }
      const applied = { item_ids: itemIds, created, skipped };
      const row = (
        await client.query<ReceiptRow>(
          `UPDATE recommendation_receipts SET status='APPLIED',apply_request_id=$2,applied_plan_version=$3,applied_at=now(),
           proposal=proposal||jsonb_build_object('applied',$4::jsonb) WHERE id=$1 RETURNING ${RECEIPT_COLUMNS}`,
          [recommendationId, operation, planVersion, JSON.stringify(applied)],
        )
      ).rows[0]!;
      await insertReceipt(client, {
        operationId: operation,
        tripId,
        operationType,
        actorUserId: actor,
        requestHash,
        contextRevision: planVersion,
        outcome: { recommendation_id: recommendationId, plan_version: planVersion },
        commandPayload: { recommendationId, itemIds, expected },
      });
      return projectRecommendation(row, true);
    });
  }

  async ignore(raw: { actor_user_id?: unknown; recommendation_id?: unknown }) {
    const actor = uuid(raw.actor_user_id),
      recommendationId = uuid(raw.recommendation_id);
    return this.database.withTransaction(async (client) => {
      const receipt =
        (
          await client.query<ReceiptRow>(
            `SELECT ${RECEIPT_COLUMNS} FROM recommendation_receipts WHERE id=$1 FOR UPDATE`,
            [recommendationId],
          )
        ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      const access = await this.access(client, receipt.trip_id, actor);
      const editor =
        access.archived_at === null &&
        isPlanEditor(access.role, access.plan_edit_policy, access.selected_editor);
      if (receipt.status === 'APPLIED') return fail('STATE_CONFLICT', 409, { reason: 'APPLIED' });
      // Ignoring never touches the Plan; a second ignore is a no-op.
      const row =
        receipt.status === 'PREVIEWED'
          ? (
              await client.query<ReceiptRow>(
                `UPDATE recommendation_receipts SET status='REJECTED' WHERE id=$1 RETURNING ${RECEIPT_COLUMNS}`,
                [recommendationId],
              )
            ).rows[0]!
          : receipt;
      return projectRecommendation(row, editor);
    });
  }
}
