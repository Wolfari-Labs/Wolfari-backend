// Shared travel_db helpers for the POI scripts (snapshots, activation, golden export).
import { resolve } from 'node:path';
import { readEnv, root } from '../config.mjs';
import { connectDatabase } from '../migrations.mjs';

export const DEFAULT_ENV = resolve(root, 'apps/travel-intelligence-service/.env');

/** travel_db URL from an app .env file (default: this checkout's travel service). */
export async function travelUrl(envPath = DEFAULT_ENV) {
  const env = await readEnv(resolve(envPath));
  if (!env.DATABASE_URL)
    throw new Error(`Thiếu cấu hình DATABASE_URL trong ${envPath}; chạy pnpm env:init.`);
  return env.DATABASE_URL;
}

/** Connect as travel_app; long-running loads raise the statement timeout for this session only. */
export async function connectTravel(url, { statementTimeout = '30s' } = {}) {
  const client = await connectDatabase('travel', url);
  await client.query(`SET statement_timeout = '${statementTimeout.replace(/[^0-9a-z]/gi, '')}'`);
  return client;
}

/** Snapshot rows: id, version, kind, active, POI count, golden count, created_at, status. */
export async function listSnapshots(client) {
  return (
    await client.query(`SELECT s.id, s.version, s.is_active AS active, s.created_at,
        s.manifest->>'kind' AS kind, coalesce(s.manifest->>'status', 'complete') AS status,
        count(p.id)::int AS pois,
        count(p.id) FILTER (WHERE p.tier IN (1, 2, 3))::int AS golden
      FROM poi_snapshots s LEFT JOIN pois p ON p.snapshot_id = s.id
      GROUP BY s.id ORDER BY s.created_at`)
  ).rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Find a snapshot by version or id; throws a readable error when missing. */
export async function findSnapshot(client, ref) {
  const { rows } = await client.query(
    `SELECT id, version, is_active, coalesce(manifest->>'status', 'complete') AS status
     FROM poi_snapshots WHERE version = $1 OR ($2 AND id::text = $1)`,
    [ref, UUID.test(ref)],
  );
  if (!rows.length) throw new Error(`Không có snapshot "${ref}". Xem danh sách: corepack pnpm poi:snapshots`);
  return rows[0];
}

/**
 * Make `ref` the only active snapshot in one transaction. Services read the active flag per
 * request, so no restart is needed. Returns { previous, current } versions.
 */
export async function activateSnapshot(client, ref) {
  let target;
  let previous;
  await client.query('BEGIN');
  try {
    // Serialise concurrent activations; readers are not blocked.
    await client.query('LOCK TABLE poi_snapshots IN SHARE ROW EXCLUSIVE MODE');
    target = await findSnapshot(client, ref);
    if (target.status !== 'complete')
      throw new Error(`Snapshot ${target.version} chưa nạp xong (status ${target.status}); không kích hoạt.`);
    const count = (await client.query('SELECT count(*)::int AS n FROM pois WHERE snapshot_id = $1', [target.id])).rows[0].n;
    if (!count) throw new Error(`Snapshot ${target.version} không có POI; không kích hoạt.`);
    previous = (await client.query('SELECT version FROM poi_snapshots WHERE is_active')).rows[0]?.version ?? null;
    await client.query('UPDATE poi_snapshots SET is_active = false WHERE is_active AND id <> $1', [target.id]);
    await client.query('UPDATE poi_snapshots SET is_active = true WHERE id = $1', [target.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  // Fresh statistics so the planner sees the new active snapshot (sample-based, ~1 s per table).
  await client.query('ANALYZE poi_snapshots');
  await client.query('ANALYZE pois');
  return { previous, current: target.version };
}

/**
 * Retention: keep the active snapshot and the newest other complete one; everything else
 * complete and inactive is removed (pois/poi_sources cascade). Snapshots still loading are
 * never touched. Returns the plan; deletes only when `dryRun` is false.
 */
export async function pruneSnapshots(client, { keep = 1, dryRun = true } = {}) {
  const rows = await listSnapshots(client);
  const active = rows.find((r) => r.active) ?? null;
  const others = rows
    .filter((r) => !r.active && r.status === 'complete')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const kept = [...(active ? [active] : []), ...others.slice(0, keep)];
  const removed = others.slice(keep);
  const skipped = rows.filter((r) => !r.active && r.status !== 'complete');
  if (!dryRun && removed.length) {
    for (const row of removed)
      await client.query('DELETE FROM poi_snapshots WHERE id = $1 AND NOT is_active', [row.id]);
    await client.query('VACUUM (ANALYZE) pois');
    await client.query('VACUUM (ANALYZE) poi_sources');
    await client.query('ANALYZE poi_snapshots');
  }
  return { kept, removed, skipped };
}

/** Golden rows of a snapshot (default: the active one) for name/coordinate matching. */
export async function exportGolden(client, ref) {
  const snapshot = ref
    ? await findSnapshot(client, ref)
    : (await client.query('SELECT id, version FROM poi_snapshots WHERE is_active')).rows[0];
  if (!snapshot) throw new Error('Không có snapshot active; truyền --golden-snapshot <version>.');
  const { rows } = await client.query(
    `SELECT wolfari_key, name_vi, name_en, aliases, category,
       latitude::float8 AS latitude, longitude::float8 AS longitude
     FROM pois WHERE snapshot_id = $1 AND tier IN (1, 2, 3) ORDER BY wolfari_key`,
    [snapshot.id],
  );
  if (!rows.length) throw new Error(`Snapshot ${snapshot.version} không có điểm golden.`);
  return { snapshot, rows };
}
