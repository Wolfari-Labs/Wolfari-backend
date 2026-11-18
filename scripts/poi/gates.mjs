#!/usr/bin/env node
// POI-OVERTURE O5: quality report for a snapshot. Reports only — never blocks, exit code 0.
// Usage: corepack pnpm poi:gates <version|id> [--against <golden version>] [--env <travel .env>]
// Writes .local/poi/reports/gates-<version>.md and .json.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { root } from '../config.mjs';
import { safeError } from '../migrations.mjs';
import { DEFAULT_ENV, connectTravel, findSnapshot, travelUrl } from './poi-db.mjs';

const require = createRequire(import.meta.url);
const { POI_SEARCH_CATEGORIES, PLACE_SEARCH_CATEGORIES, VN_PROVINCES } = require('../../packages/common/dist/index.js');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { env: { type: 'string', default: DEFAULT_ENV }, against: { type: 'string' } },
});

/** code → group as SQL VALUES, so the database groups exactly like the API. */
const groupValues = PLACE_SEARCH_CATEGORIES.flatMap((group) =>
  POI_SEARCH_CATEGORIES[group].map((code) => `('${code}', '${group}')`),
).join(', ');

async function main() {
  const ref = positionals[0];
  if (!ref) throw new Error('Lệnh: corepack pnpm poi:gates <snapshot>');
  const client = await connectTravel(await travelUrl(args.env), { statementTimeout: '15min' });
  try {
    await client.query("SET work_mem = '32MB'");
    const snapshot = await findSnapshot(client, ref);
    const manifest = (await client.query('SELECT manifest FROM poi_snapshots WHERE id = $1', [snapshot.id])).rows[0].manifest;
    const againstRef = args.against ?? manifest.golden_snapshot;
    const against = againstRef ? await findSnapshot(client, againstRef) : null;
    const id = snapshot.id;

    const provinces = (
      await client.query(
        `WITH g(code, grp) AS (VALUES ${groupValues})
         SELECT coalesce(p.province_code, '(null)') AS province_code, g.grp, count(*)::int AS n,
           count(*) FILTER (WHERE p.category = 'temple')::int AS temples
         FROM pois p LEFT JOIN g ON g.code = p.category
         WHERE p.snapshot_id = $1 GROUP BY 1, 2`,
        [id],
      )
    ).rows;
    const byProvince = {};
    for (const row of provinces) {
      const entry = (byProvince[row.province_code] ??= {
        province_code: row.province_code,
        province_name: VN_PROVINCES[row.province_code] ?? '',
        total: 0,
        groups: Object.fromEntries(PLACE_SEARCH_CATEGORIES.map((g) => [g, 0])),
        temples: 0,
      });
      entry.total += row.n;
      entry.groups[row.grp ?? '(no group)'] = (entry.groups[row.grp ?? '(no group)'] ?? 0) + row.n;
      entry.temples += row.temples;
    }
    const perProvince = Object.values(byProvince)
      .map((e) => ({
        ...e,
        temple_pct_of_tourism: e.groups.tourism ? Number(((100 * e.temples) / e.groups.tourism).toFixed(1)) : 0,
        other: e.groups.other,
      }))
      .sort((a, b) => a.province_code.localeCompare(b.province_code));
    const missingProvinces = Object.keys(VN_PROVINCES).filter((code) => !byProvince[code]);

    let golden = null;
    if (against) {
      golden = (
        await client.query(
          `SELECT count(o.*)::int AS expected,
             count(n.*)::int AS present,
             count(n.*) FILTER (WHERE n.latitude = o.latitude AND n.longitude = o.longitude
               AND n.tier = o.tier AND n.coord_verified = o.coord_verified)::int AS unchanged,
             coalesce(array_agg(o.wolfari_key ORDER BY o.wolfari_key) FILTER (WHERE n.id IS NULL), '{}') AS missing,
             coalesce(array_agg(o.wolfari_key ORDER BY o.wolfari_key) FILTER (WHERE n.id IS NOT NULL AND
               (n.latitude <> o.latitude OR n.longitude <> o.longitude OR n.tier <> o.tier OR n.coord_verified <> o.coord_verified)), '{}') AS changed
           FROM pois o LEFT JOIN pois n ON n.snapshot_id = $1 AND n.wolfari_key = o.wolfari_key
           WHERE o.snapshot_id = $2`,
          [id, against.id],
        )
      ).rows[0];
      golden.against = against.version;
    }

    const pileups = (
      await client.query(
        `SELECT round(latitude, 5)::float8 AS lat, round(longitude, 5)::float8 AS lon,
           count(DISTINCT lower(unaccent(name_vi)))::int AS names, count(*)::int AS pois
         FROM pois WHERE snapshot_id = $1 GROUP BY 1, 2
         HAVING count(DISTINCT lower(unaccent(name_vi))) > 20 ORDER BY names DESC LIMIT 50`,
        [id],
      )
    ).rows;
    const outside = (
      await client.query(
        `SELECT count(*)::int AS n FROM pois WHERE snapshot_id = $1
         AND (province_code IS NULL OR NOT province_code = ANY($2::text[]))`,
        [id, Object.keys(VN_PROVINCES)],
      )
    ).rows[0].n;
    // Same folded name, same group, ~30 m grid cell: duplicates the build should have merged.
    const duplicates = (
      await client.query(
        `WITH g(code, grp) AS (VALUES ${groupValues})
         SELECT count(*)::int AS groups, coalesce(sum(n - 1), 0)::int AS extra FROM (
           SELECT count(*) AS n FROM pois p JOIN g ON g.code = p.category
           WHERE p.snapshot_id = $1
           GROUP BY lower(unaccent(p.name_vi)), g.grp, floor(p.latitude / 0.00027), floor(p.longitude / 0.00027)
           HAVING count(*) > 1) d`,
        [id],
      )
    ).rows[0];
    const licenses = (
      await client.query(
        `SELECT count(*) FILTER (WHERE coalesce(license, '') = '')::int AS missing_license,
           count(*) FILTER (WHERE coalesce(attribution, '') = '')::int AS missing_attribution,
           count(*) FILTER (WHERE source_dataset = 'overture' AND NOT EXISTS (
             SELECT 1 FROM poi_sources s WHERE s.poi_id = p.id AND s.source = 'overture'))::int AS overture_without_source
         FROM pois p WHERE snapshot_id = $1`,
        [id],
      )
    ).rows[0];
    const totals = (
      await client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE tier IN (1, 2, 3))::int AS golden,
           count(*) FILTER (WHERE source_dataset = 'overture')::int AS overture
         FROM pois WHERE snapshot_id = $1`,
        [id],
      )
    ).rows[0];

    const report = {
      snapshot: snapshot.version,
      generated_at: new Date().toISOString(),
      totals,
      golden_recall: golden,
      outside_polygon_or_unknown_province: outside,
      provinces_without_pois: missingProvinces,
      coordinate_pileups: pileups,
      leftover_duplicates: duplicates,
      licenses,
      per_province: perProvince,
    };
    const dir = resolve(root, '.local/poi/reports');
    await mkdir(dir, { recursive: true });
    const base = resolve(dir, `gates-${snapshot.version}`);
    await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    const groups = PLACE_SEARCH_CATEGORIES;
    const md = [
      `# Cổng chất lượng — ${snapshot.version}`,
      '',
      '_Chỉ báo cáo, không chặn nạp._',
      '',
      `- Tổng POI: ${totals.total} (golden ${totals.golden}, Overture ${totals.overture})`,
      golden
        ? `- Golden so với ${golden.against}: có mặt ${golden.present}/${golden.expected}, tọa độ/tier/coord_verified không đổi ${golden.unchanged}/${golden.expected}` +
          (golden.missing.length ? `; THIẾU: ${golden.missing.join(', ')}` : '') +
          (golden.changed.length ? `; ĐỔI: ${golden.changed.join(', ')}` : '')
        : '- Golden: không có snapshot đối chiếu',
      `- Ngoài polygon / mã tỉnh lạ: ${outside}`,
      `- Tỉnh không có POI: ${missingProvinces.join(', ') || 'không'}`,
      `- Cặp trùng còn sót (cùng tên chuẩn hóa, cùng nhóm, cùng ô ~30 m): ${duplicates.groups} nhóm, ${duplicates.extra} bản thừa`,
      `- Thiếu license: ${licenses.missing_license} · thiếu attribution: ${licenses.missing_attribution} · POI Overture không có poi_sources: ${licenses.overture_without_source}`,
      `- Tọa độ dồn (> 20 tên khác nhau cùng tọa độ 5 chữ số): ${pileups.length}`,
      ...pileups.slice(0, 20).map((p) => `  - ${p.lat}, ${p.lon}: ${p.names} tên / ${p.pois} POI`),
      '',
      '## Theo tỉnh',
      '',
      `| Mã | Tỉnh | Tổng | ${groups.join(' | ')} | % thờ tự / tourism |`,
      `| --- | --- | --- | ${groups.map(() => '---').join(' | ')} | --- |`,
      ...perProvince.map(
        (p) => `| ${p.province_code} | ${p.province_name} | ${p.total} | ${groups.map((g) => p.groups[g] ?? 0).join(' | ')} | ${p.temple_pct_of_tourism} |`,
      ),
      '',
    ].join('\n');
    await writeFile(`${base}.md`, md);
    console.log(md.split('\n## Theo tỉnh')[0]);
    console.log(`Báo cáo: ${base.slice(root.length + 1)}.md / .json`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? '');
  console.error(/^(Không có|Lệnh|Thiếu cấu hình)/.test(message) ? message : safeError(error));
  // Gates never block: report the failure, keep exit code 0.
});
