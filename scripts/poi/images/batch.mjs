// POI-IMAGES: writing a media batch (load step). The travel service serves exactly one active
// batch, so a nationwide batch is built either in one go or one province at a time with `--into`:
// each run replaces only its own POIs' rows and keeps every other POI's rows.
// Everything here is testable without a database (scripts/poi-images.test.ts).

/** Photos the load step downloads: hero + gallery, or only the hero (`--hero-only`). */
export function photosToStore(selection, { heroOnly = false } = {}) {
  return selection.flatMap((s) => [
    ...(s.hero ? [{ s, photo: s.hero, role: 'hero', rank: 0 }] : []),
    ...(heroOnly ? [] : s.gallery.map((photo, i) => ({ s, photo, role: 'gallery', rank: i + 1 }))),
  ]);
}

/**
 * POIs whose rows a cumulative run replaces: every POI of the run, except those whose chosen hero
 * could not be stored this time, so a transient download error keeps their previous photos.
 * A POI that now has no photo at all loses its old rows: the latest run decides.
 */
export function replacedKeys(selection, failedHeroKeys = new Set()) {
  const keys = { golden: [], gers: [] };
  for (const s of selection) {
    if (failedHeroKeys.has(s.key)) continue;
    keys[s.kind === 'overture' ? 'gers' : 'golden'].push(s.key);
  }
  return keys;
}
const withoutRun = (manifest) =>
  Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'run'));
const covers = (keys) => {
  const golden = new Set(keys.golden);
  const gers = new Set(keys.gers);
  return (row) => (row.golden_key ? golden.has(row.golden_key) : gers.has(row.gers_id));
};

/**
 * Manifest of a cumulative batch: one entry per run (a rerun replaces its entry), photo totals
 * counted in the database. A batch first loaded without `--into` becomes the first run entry.
 */
export function mergeManifest(previous, next, totals, batch) {
  const prior = Array.isArray(previous?.runs)
    ? previous.runs
    : previous?.pois !== undefined
      ? [{ run: batch, pois: previous.pois, heroes: previous.heroes, gallery: previous.gallery }]
      : [];
  const runs = [...prior.filter((r) => r.run !== next.run.run), next.run];
  return {
    ...withoutRun(next),
    cumulative: true,
    runs,
    // Sum over runs: a POI pulled by two differently named runs is counted twice.
    pois: runs.reduce((n, r) => n + (r.pois ?? 0), 0),
    heroes: Number(totals.heroes),
    gallery: Number(totals.gallery),
    files: Number(totals.files),
  };
}

const MEDIA_COLUMNS = `gers_id, golden_key, role, rank, source, source_url, original_url, storage_key, width, height,
  bytes, mime, sha256, license_code, license_url, author, attribution, match_method, match_score, quality_score,
  final_score`;
export const SQL = Object.freeze({
  exists: 'SELECT 1 FROM poi_media_batches WHERE id = $1',
  dropBatch: 'DELETE FROM poi_media_batches WHERE id = $1',
  createBatch: 'INSERT INTO poi_media_batches(id, manifest) VALUES ($1, $2)',
  ensureBatch:
    'INSERT INTO poi_media_batches(id, manifest) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
  // Serialises cumulative runs into the same batch.
  lockBatch: 'SELECT manifest FROM poi_media_batches WHERE id = $1 FOR UPDATE',
  // Taken-down rows stay: the same photo then hits the (batch, key, sha256) index and is skipped.
  deleteMedia: `DELETE FROM poi_media WHERE batch_id = $1 AND status <> 'takedown'
    AND (golden_key = ANY($2::text[]) OR gers_id = ANY($3::text[]))`,
  deleteLinks: `DELETE FROM poi_entity_links WHERE batch_id = $1
    AND (golden_key = ANY($2::text[]) OR gers_id = ANY($3::text[]))`,
  insertMedia: `INSERT INTO poi_media(${MEDIA_COLUMNS}, batch_id, fetched_at)
    SELECT ${MEDIA_COLUMNS}, $2, now()
    FROM jsonb_to_recordset($1::jsonb) AS r(gers_id text, golden_key text, role text, rank int, source text,
      source_url text, original_url text, storage_key text, width int, height int, bytes int, mime text, sha256 text,
      license_code text, license_url text, author text, attribution text, match_method text, match_score numeric,
      quality_score numeric, final_score numeric)
    ON CONFLICT DO NOTHING`,
  insertLinks: `INSERT INTO poi_entity_links(gers_id, golden_key, scheme, value, method, score, batch_id)
    SELECT gers_id, golden_key, scheme, value, method, score, $2 FROM jsonb_to_recordset($1::jsonb)
      AS e(gers_id text, golden_key text, scheme text, value text, method text, score numeric)`,
  totals: `SELECT count(*) FILTER (WHERE role = 'hero') AS heroes, count(*) FILTER (WHERE role = 'gallery') AS gallery,
    count(DISTINCT sha256) AS files FROM poi_media WHERE batch_id = $1 AND status = 'accepted'`,
  setManifest: 'UPDATE poi_media_batches SET manifest = $2 WHERE id = $1',
  // Two statements: the partial unique index allows only one active row at any moment.
  deactivateOthers: 'UPDATE poi_media_batches SET is_active = false WHERE is_active AND id <> $1',
  activate: 'UPDATE poi_media_batches SET is_active = true WHERE id = $1',
});

/**
 * One transaction. `mode`:
 * - create  new batch; fails when it exists
 * - replace drop the batch (rows cascade) and load it again
 * - merge   (`--into`) create the batch if missing, then replace only `keys`' rows; rows of other
 *           POIs stay, so running the same run again gives the same rows (idempotent)
 * `manifest` is the run's manifest; in merge mode it carries `run` and is merged into the batch's.
 */
export async function writeBatch(
  client,
  { batch, mode, rows, links, keys, manifest, activate = false },
) {
  await client.query('BEGIN');
  try {
    let previous;
    if (mode === 'merge') {
      await client.query(SQL.ensureBatch, [
        batch,
        { ...withoutRun(manifest), cumulative: true, runs: [] },
      ]);
      previous = (await client.query(SQL.lockBatch, [batch])).rows[0]?.manifest;
      await client.query(SQL.deleteMedia, [batch, keys.golden, keys.gers]);
      await client.query(SQL.deleteLinks, [batch, keys.golden, keys.gers]);
      const mine = covers(keys);
      rows = rows.filter(mine);
      links = links.filter(mine);
    } else {
      const existing = await client.query(SQL.exists, [batch]);
      if (existing.rowCount && mode !== 'replace')
        throw new Error(
          `Batch ${batch} đã có; thêm --replace để nạp lại hoặc --into ${batch} để cộng dồn.`,
        );
      // --replace: drop the old rows of this batch (cascade) and load again in the same transaction.
      if (existing.rowCount) await client.query(SQL.dropBatch, [batch]);
      await client.query(SQL.createBatch, [batch, manifest]);
    }
    await client.query(SQL.insertMedia, [JSON.stringify(rows), batch]);
    await client.query(SQL.insertLinks, [JSON.stringify(links), batch]);
    let result = manifest;
    if (mode === 'merge') {
      const totals = (await client.query(SQL.totals, [batch])).rows[0];
      result = mergeManifest(previous, manifest, totals, batch);
      await client.query(SQL.setManifest, [batch, result]);
    }
    if (activate) {
      await client.query(SQL.deactivateOthers, [batch]);
      await client.query(SQL.activate, [batch]);
    }
    await client.query('COMMIT');
    return { manifest: result, rows: rows.length, links: links.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
