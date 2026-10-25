import { withPriceWatchTransaction } from './price-watch-transaction';
import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { PoolClient, QueryResultRow } from 'pg';
import type { NormalizedPriceQuery, NormalizedWatchWrite, WatchStatus } from './price-watch.domain';
import { priceWatchFail } from './price-watch.errors';

type WatchRow = QueryResultRow & {
  id: string;
  query_group_id: string;
  user_id: string;
  trip_id: string;
  owner_membership_id: string;
  threshold_price: string;
  currency: string;
  status: WatchStatus;
  status_reason: string | null;
  version: number;
  expires_at: Date | string;
  last_alert_price: string | null;
  last_alert_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  client_request_id: string;
  request_hash: string;
  canonical_key: string;
  params: NormalizedPriceQuery | string;
};

type ObservationRow = QueryResultRow & {
  id: string;
  price: string;
  currency: string;
  provider: string;
  fare_metadata: unknown;
  observed_at: Date | string;
  fetched_at: Date | string;
};

export interface PriceWatchRecord {
  id: string;
  query_group_id: string;
  user_id: string;
  trip_id: string;
  owner_membership_id: string;
  threshold_price: string;
  currency: string;
  status: WatchStatus;
  status_reason: string | null;
  version: number;
  expires_at: string;
  last_alert_price: string | null;
  last_alert_at: string | null;
  created_at: string;
  updated_at: string;
  client_request_id: string;
  request_hash: string;
  canonical_key: string;
  query: NormalizedPriceQuery;
}

export interface ObservationRecord {
  id: string;
  price: string;
  currency: string;
  provider: string;
  fare_metadata: unknown;
  observed_at: string;
  fetched_at: string;
}

const WATCH_SELECT = `SELECT
  w.id,w.query_group_id,w.user_id,w.trip_id,w.owner_membership_id,w.threshold_price::text,
  w.currency,w.status,w.status_reason,w.version,w.expires_at,w.last_alert_price::text,
  w.last_alert_at,w.created_at,w.updated_at,w.client_request_id,w.request_hash,
  q.canonical_key,q.params
FROM price_watches w JOIN price_query_groups q ON q.id=w.query_group_id`;

function iso(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error('Invalid database timestamp');
  return result.toISOString();
}

function json<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function project(row: WatchRow): PriceWatchRecord {
  return {
    ...row,
    threshold_price: String(row.threshold_price),
    last_alert_price: row.last_alert_price === null ? null : String(row.last_alert_price),
    expires_at: iso(row.expires_at),
    last_alert_at: row.last_alert_at === null ? null : iso(row.last_alert_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    query: json<NormalizedPriceQuery>(row.params),
  };
}

async function queryGroup(client: PoolClient, value: NormalizedWatchWrite): Promise<string> {
  const inserted = await client.query<{ id: string; params: NormalizedPriceQuery | string }>(
    `INSERT INTO price_query_groups(
       provider,transport_type,canonical_key,origin,destination,departure_date,return_date,
       passenger_count,cabin_class,currency,params,active,next_check_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,true,now())
     ON CONFLICT(canonical_key) DO NOTHING RETURNING id,params`,
    [
      value.query.provider,
      value.query.transport_type,
      value.canonical_key,
      value.query.origin,
      value.query.destination,
      value.query.departure_date,
      value.query.return_date,
      value.query.passenger_count,
      value.query.cabin_class,
      value.query.currency,
      JSON.stringify(value.query),
    ],
  );
  const found =
    inserted.rows[0] ??
    (
      await client.query<{ id: string; params: NormalizedPriceQuery | string }>(
        'SELECT id,params FROM price_query_groups WHERE canonical_key=$1 FOR UPDATE',
        [value.canonical_key],
      )
    ).rows[0];
  if (!found || canonicalJson(json(found.params)) !== canonicalJson(value.query))
    return priceWatchFail('SERVICE_UNAVAILABLE');
  return found.id;
}

async function wakeQueryGroup(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE price_query_groups SET active=true,
       next_check_at=LEAST(COALESCE(next_check_at,clock_timestamp()),clock_timestamp()),
       updated_at=clock_timestamp() WHERE id=$1`,
    [id],
  );
}

async function reconcileQueryGroup(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE price_query_groups q SET active=state.has_active,
       next_check_at=CASE WHEN state.has_active THEN COALESCE(q.next_check_at,clock_timestamp()) ELSE NULL END,
       updated_at=clock_timestamp()
     FROM (
       SELECT EXISTS(
         SELECT 1 FROM price_watches w
         WHERE w.query_group_id=$1 AND w.status='ACTIVE' AND w.expires_at>clock_timestamp()
       ) AS has_active
     ) state WHERE q.id=$1`,
    [id],
  );
}

@Injectable()
export class PriceWatchRepository {
  constructor(private readonly database: DatabaseProvider) {}

  async create(input: {
    userId: string;
    tripId: string;
    membershipId: string;
    clientRequestId: string;
    value: NormalizedWatchWrite;
  }): Promise<PriceWatchRecord> {
    return withPriceWatchTransaction(this.database, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${input.userId}:${input.clientRequestId}`,
      ]);
      const replay = (
        await client.query<WatchRow>(
          `${WATCH_SELECT} WHERE w.user_id=$1 AND w.client_request_id=$2`,
          [input.userId, input.clientRequestId],
        )
      ).rows[0];
      if (replay) {
        if (
          replay.trip_id !== input.tripId ||
          replay.owner_membership_id !== input.membershipId ||
          replay.request_hash !== input.value.request_hash
        )
          return priceWatchFail('IDEMPOTENCY_CONFLICT');
        return project(replay);
      }
      const queryGroupId = await queryGroup(client, input.value);
      const inserted = await client.query<WatchRow>(
        `INSERT INTO price_watches(
           query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,status,
           expires_at,client_request_id,request_hash
         ) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9)
         RETURNING id,query_group_id,user_id,trip_id,owner_membership_id,threshold_price::text,
           currency,status,status_reason,version,expires_at,last_alert_price::text,last_alert_at,
           created_at,updated_at,client_request_id,request_hash,$10::text AS canonical_key,
           $11::jsonb AS params`,
        [
          queryGroupId,
          input.userId,
          input.tripId,
          input.membershipId,
          input.value.threshold_price,
          input.value.query.currency,
          input.value.expires_at,
          input.clientRequestId,
          input.value.request_hash,
          input.value.canonical_key,
          JSON.stringify(input.value.query),
        ],
      );
      await wakeQueryGroup(client, queryGroupId);
      return project(inserted.rows[0]!);
    });
  }

  async find(id: string): Promise<PriceWatchRecord | undefined> {
    const row = (await this.database.query<WatchRow>(`${WATCH_SELECT} WHERE w.id=$1`, [id]))
      .rows[0];
    return row ? project(row) : undefined;
  }

  async list(
    tripId: string,
    limit: number,
    after?: { sort_at: string; id: string },
  ): Promise<PriceWatchRecord[]> {
    const rows = await this.database.query<WatchRow>(
      `${WATCH_SELECT} WHERE w.trip_id=$1
       AND ($2::timestamptz IS NULL OR (w.created_at,w.id)<($2::timestamptz,$3::uuid))
       ORDER BY w.created_at DESC,w.id DESC LIMIT $4`,
      [tripId, after?.sort_at ?? null, after?.id ?? null, limit],
    );
    return rows.rows.map(project);
  }

  async update(
    id: string,
    expectedVersion: number,
    value: NormalizedWatchWrite,
    authorize: (locked: PriceWatchRecord) => void,
  ): Promise<PriceWatchRecord> {
    return withPriceWatchTransaction(this.database, async (client) => {
      const row = (
        await client.query<WatchRow>(`${WATCH_SELECT} WHERE w.id=$1 FOR UPDATE OF w`, [id])
      ).rows[0];
      if (!row) return priceWatchFail('RESOURCE_NOT_FOUND');
      const current = project(row);
      authorize(current);
      if (current.version !== expectedVersion)
        return priceWatchFail('VERSION_CONFLICT', { current_version: current.version });
      if (current.status === 'STOPPED' || current.status === 'EXPIRED')
        return priceWatchFail('STATE_CONFLICT');
      if (
        current.canonical_key === value.canonical_key &&
        current.threshold_price === value.threshold_price &&
        current.expires_at === value.expires_at
      )
        return current;
      if (current.version === 2_147_483_647) return priceWatchFail('STATE_CONFLICT');
      const groupId = await queryGroup(client, value);
      const changed = await client.query<WatchRow>(
        `UPDATE price_watches SET query_group_id=$2,threshold_price=$3,currency=$4,expires_at=$5,
           alert_armed=CASE
             WHEN query_group_id<>$2 OR threshold_price<>$3 THEN true
             ELSE alert_armed
           END,
           version=version+1,updated_at=now()
         WHERE id=$1
         RETURNING id,query_group_id,user_id,trip_id,owner_membership_id,threshold_price::text,
           currency,status,status_reason,version,expires_at,last_alert_price::text,last_alert_at,
           created_at,updated_at,client_request_id,request_hash,$6::text AS canonical_key,
           $7::jsonb AS params`,
        [
          id,
          groupId,
          value.threshold_price,
          value.query.currency,
          value.expires_at,
          value.canonical_key,
          JSON.stringify(value.query),
        ],
      );
      if (current.status === 'ACTIVE') await wakeQueryGroup(client, groupId);
      else await reconcileQueryGroup(client, groupId);
      if (current.query_group_id !== groupId)
        await reconcileQueryGroup(client, current.query_group_id);
      return project(changed.rows[0]!);
    });
  }

  async changeStatus(
    id: string,
    expectedVersion: number,
    next: WatchStatus,
    reason: string | null,
    authorize: (locked: PriceWatchRecord) => void,
  ): Promise<PriceWatchRecord> {
    return withPriceWatchTransaction(this.database, async (client) => {
      const row = (
        await client.query<WatchRow>(`${WATCH_SELECT} WHERE w.id=$1 FOR UPDATE OF w`, [id])
      ).rows[0];
      if (!row) return priceWatchFail('RESOURCE_NOT_FOUND');
      const current = project(row);
      authorize(current);
      if (current.version !== expectedVersion)
        return priceWatchFail('VERSION_CONFLICT', { current_version: current.version });
      if (current.version === 2_147_483_647) return priceWatchFail('STATE_CONFLICT');
      await client.query(
        `UPDATE price_watches SET status=$2,status_reason=$3,version=version+1,updated_at=now()
         WHERE id=$1`,
        [id, next, reason],
      );
      if (next === 'ACTIVE') await wakeQueryGroup(client, current.query_group_id);
      else await reconcileQueryGroup(client, current.query_group_id);
      const changed = await client.query<WatchRow>(`${WATCH_SELECT} WHERE w.id=$1`, [id]);
      return project(changed.rows[0]!);
    });
  }

  async listObservations(
    queryGroupId: string,
    limit: number,
    after?: { sort_at: string; id: string },
  ): Promise<ObservationRecord[]> {
    const result = await this.database.query<ObservationRow>(
      `SELECT id,price::text,currency,provider,fare_metadata,observed_at,fetched_at
       FROM price_observations WHERE query_group_id=$1
       AND ($2::timestamptz IS NULL OR (observed_at,id)<($2::timestamptz,$3::uuid))
       ORDER BY observed_at DESC,id DESC LIMIT $4`,
      [queryGroupId, after?.sort_at ?? null, after?.id ?? null, limit],
    );
    return result.rows.map((row) => ({
      ...row,
      price: String(row.price),
      observed_at: iso(row.observed_at),
      fetched_at: iso(row.fetched_at),
    }));
  }
}
