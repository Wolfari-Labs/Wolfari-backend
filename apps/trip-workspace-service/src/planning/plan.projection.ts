import { iso, type QueryClient } from '../trip-common';

export type PlanPolicy = 'OWNER_ONLY' | 'ALL_MEMBERS' | 'SELECTED_MEMBERS';
export type ActivityStatus = 'TODO' | 'COMPLETED';
export type EntitySource = 'MANUAL' | 'PROVIDER' | 'DSS';
type DbTime = Date | string;
export interface PlanVersion {
  trip_id: string;
  plan_version: number;
  export_revision: number;
}
export interface AccessRow {
  id: string;
  start_at: DbTime;
  end_at: DbTime;
  plan_edit_policy: PlanPolicy;
  plan_version: number;
  export_revision: number;
  archived_at: DbTime | null;
  membership_id: string;
  role: 'OWNER' | 'MEMBER';
  selected_editor: boolean;
}
export interface ActivityRow {
  id: string;
  trip_id: string;
  title: string;
  description: string | null;
  public_description: string | null;
  activity_type: string;
  selected_location_id: string | null;
  starts_at: DbTime | null;
  ends_at: DbTime | null;
  position: number;
  status: ActivityStatus;
  source: EntitySource;
  completed_by_user_id: string | null;
  completed_at: DbTime | null;
  created_by_user_id: string;
}
export interface LocationRow {
  id: string;
  trip_id: string;
  name: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  provider: string | null;
  provider_place_id: string | null;
  source: EntitySource;
  opening_hours: unknown;
  fetched_at: DbTime | null;
  metadata: Record<string, unknown>;
}
export interface DressCodeRow {
  id: string;
  trip_id: string;
  scope_type: 'TRIP' | 'DAY' | 'ACTIVITY';
  plan_date: string | null;
  activity_id: string | null;
  label: string;
  description: string | null;
  public_description: string | null;
  source: EntitySource;
}
export interface PackingRow {
  id: string;
  trip_id: string;
  name: string;
  quantity: string;
  unit: string | null;
  note: string | null;
  category: string | null;
  assigned_member_id: string | null;
  due_at: DbTime | null;
  status: ActivityStatus;
  source: EntitySource;
  completed_by_user_id: string | null;
  completed_at: DbTime | null;
}
export type ActivityView = ReturnType<typeof projectActivity>;
export type PlanView = PlanVersion & {
  activities: ActivityView[];
  selected_locations: ReturnType<typeof projectLocation>[];
  dress_codes: ReturnType<typeof projectDressCode>[];
  packing_items: ReturnType<typeof projectPackingItem>[];
  permissions: { can_read: boolean; can_edit: boolean; can_complete: boolean };
};

export const ACCESS_SQL = `SELECT t.id,t.start_at,t.end_at,t.plan_edit_policy,t.plan_version,
  t.export_revision,t.archived_at,m.id AS membership_id,m.role,
  EXISTS (SELECT 1 FROM trip_plan_editors e
          WHERE e.trip_id=t.id AND e.trip_member_id=m.id) AS selected_editor
  FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL
  WHERE t.id=$1 AND t.deleted_at IS NULL`;
export const ACTIVITY_COLUMNS = `id,trip_id,title,description,public_description,activity_type,
  selected_location_id,starts_at,ends_at,position,status,source,
  completed_by_user_id,completed_at,created_by_user_id`;
export const LOCATION_METADATA_KEYS: readonly string[] = [];
const time = (value: DbTime | null) => (value === null ? null : iso(value));

export function projectActivity(row: ActivityRow, version: number) {
  return {
    ...row,
    starts_at: time(row.starts_at),
    ends_at: time(row.ends_at),
    completed_at: time(row.completed_at),
    plan_version: version,
  };
}
export function projectLocation(row: LocationRow, version: number) {
  const metadata = Object.fromEntries(
    Object.entries(row.metadata).filter(([key]) => LOCATION_METADATA_KEYS.includes(key)),
  );
  return { ...row, fetched_at: time(row.fetched_at), metadata, plan_version: version };
}
export function projectDressCode(row: DressCodeRow, version: number) {
  return { ...row, plan_version: version };
}
export function projectPackingItem(row: PackingRow, version: number) {
  return {
    ...row,
    due_at: time(row.due_at),
    completed_at: time(row.completed_at),
    plan_version: version,
  };
}
export async function readPlanLists(client: QueryClient, tripId: string, version: number) {
  const activities = await client.query<ActivityRow>(
    `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE trip_id=$1 ORDER BY position,id`,
    [tripId],
  );
  const locations = await client.query<LocationRow>(
    `SELECT id,trip_id,name,address,
    latitude::text,longitude::text,provider,provider_place_id,source,opening_hours,fetched_at,metadata
    FROM selected_locations WHERE trip_id=$1 ORDER BY created_at,id`,
    [tripId],
  );
  const dress = await client.query<DressCodeRow>(
    `SELECT id,trip_id,scope_type,
    to_char(plan_date,'YYYY-MM-DD') AS plan_date,activity_id,label,description,public_description,source
    FROM dress_codes WHERE trip_id=$1
    ORDER BY CASE scope_type WHEN 'TRIP' THEN 0 WHEN 'DAY' THEN 1 ELSE 2 END,plan_date,created_at,id`,
    [tripId],
  );
  const packing = await client.query<PackingRow>(
    `SELECT id,trip_id,name,quantity::text,unit,note,
    category,assigned_member_id,due_at,status,source,completed_by_user_id,completed_at
    FROM packing_items WHERE trip_id=$1 ORDER BY created_at,id`,
    [tripId],
  );
  return {
    activities: activities.rows.map((row) => projectActivity(row, version)),
    selected_locations: locations.rows.map((row) => projectLocation(row, version)),
    dress_codes: dress.rows.map((row) => projectDressCode(row, version)),
    packing_items: packing.rows.map((row) => projectPackingItem(row, version)),
  };
}
