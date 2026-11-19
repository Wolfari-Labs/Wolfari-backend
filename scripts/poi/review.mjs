#!/usr/bin/env node
// Render data/poi/danang_golden.review.md from the golden CSV, the Nominatim cache, the
// candidate list (find-candidates.mjs) and the reviewer's overrides. Read-only except the .md.
// Usage: node scripts/poi/review.mjs [--csv <path>]
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.mjs';
import { nominatimUrl } from './osm.mjs';
import { applyOverride, parseOverrides } from './overrides.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const osmLink = (lat, lon) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
const searchLink = (text) =>
  `https://www.openstreetmap.org/search?query=${encodeURIComponent(text)}`;
const GROUPS = [
  ['missing', 'Nominatim không tìm thấy — cần chọn ứng viên hoặc nhập tay'],
  ['mismatch', 'Đang khớp sai đối tượng'],
  ['center', 'Ghim ở tâm vùng — cần cổng chính, nơi bán vé hoặc bến tàu'],
];

export function paths(csvPath) {
  const dir = dirname(csvPath);
  return {
    review: csvPath.replace(/\.csv$/, '.review.md'),
    overrides: csvPath.replace(/\.csv$/, '.overrides.csv'),
    candidates: csvPath.replace(/\.csv$/, '.candidates.json'),
    nominatimCache: resolve(dir, '.nominatim-cache.json'),
  };
}

const readJson = async (path, fallback) =>
  existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : fallback;

/** Recover which cached Nominatim result produced the CSV coordinate (name_vi → name_en → aliases). */
function cachedMatch(row, cache) {
  if (row.coord_source !== 'nominatim' || !row.osm_ref) return undefined;
  const queries = [row.name_vi, row.name_en, ...(row.aliases ?? '').split('|')]
    .map((x) => x?.trim())
    .filter(Boolean);
  for (const query of queries) {
    const results = cache[nominatimUrl(query).search];
    if (results === undefined) return undefined;
    if (results.length)
      return `${results[0].osm_type}/${results[0].osm_id}` === row.osm_ref
        ? { usedQuery: query, results }
        : undefined;
  }
  return undefined;
}

function candidateLine(c, index) {
  const distance = Number.isFinite(c.distance_m)
    ? ` · cách ${c.distance_from ?? 'ghim hiện tại'} ${Math.round(c.distance_m)} m`
    : '';
  const tags = c.tags?.length ? ` (${c.tags.join(', ')})` : '';
  return `  ${index + 1}. ${c.lat}, ${c.lon} — "${c.name || '(không tên)'}"${tags} · ${c.osm} · tìm bằng: ${c.found_by}${distance} — [Bản đồ](${osmLink(c.lat, c.lon)})`;
}

export async function writeReview(csvPath) {
  const file = paths(csvPath);
  const { records: original } = parseCsv(await readFile(csvPath, 'utf8'));
  const cache = await readJson(file.nominatimCache, {});
  const candidates = await readJson(file.candidates, null);
  let overrides = new Map();
  let overrideErrors = [];
  if (existsSync(file.overrides)) {
    ({ overrides, errors: overrideErrors } = parseOverrides(
      await readFile(file.overrides, 'utf8'),
      new Set(original.map((r) => r.wolfari_key)),
    ));
  }
  const records = original.map((r) => applyOverride(r, overrides.get(r.wolfari_key)));
  const byKey = new Map(records.map((r) => [r.wolfari_key, r]));
  const has = (r) => Boolean(r.lat && r.lon);
  const lines = [
    '# Kiểm tọa độ golden list Đà Nẵng',
    '',
    `Sinh bởi \`scripts/poi/review.mjs\` lúc ${new Date().toISOString()}. Nguồn: © OpenStreetMap contributors (Nominatim, Overpass; ODbL).`,
    '',
    'Script **không** tự quyết điểm nào đúng: ứng viên chỉ được liệt kê; tọa độ chỉ đổi khi bạn ghi vào file override.',
    '',
    '## Cách kiểm và nạp lại',
    '',
    '1. Bấm link **[Bản đồ]** ở từng dòng (openstreetmap.org, zoom 18) để đối chiếu với vị trí thật.',
    '2. Ghi quyết định vào `data/poi/danang_golden.overrides.csv` (đã có sẵn một dòng trống cho mỗi điểm; cột `wolfari_key,lat,lon,coord_verified,note`):',
    '   - Ghim hiện tại đúng → `coord_verified` = `true`, để trống `lat`, `lon`.',
    '   - Chọn một ứng viên hoặc tự lấy tọa độ → điền `lat`, `lon` (độ thập phân, ví dụ `16.068352`) và `coord_verified` = `true` nếu đã kiểm (để trống nghĩa là `false`).',
    '   - Chưa kiểm → để trống cả dòng. `note` ghi tự do (ví dụ "ứng viên 2", "cổng bán vé").',
    '3. Nạp lại: `corepack pnpm poi:load` — dòng override thắng CSV gốc; nếu override sai định dạng lệnh dừng và không nạp gì.',
    '',
    `Tổng: ${records.length} điểm · có tọa độ: ${records.filter(has).length} · chưa có: ${records.filter((r) => !has(r)).length} · đã xác minh: ${records.filter((r) => r.coord_verified === 'true').length} · dòng override đang dùng: ${overrides.size}`,
    '',
  ];
  if (overrideErrors.length)
    lines.push(
      '> ⚠ File override có lỗi (poi:load sẽ dừng):',
      ...overrideErrors.map((e) => `> - ${e}`),
      '',
    );

  const rowLine = (row) => {
    const checked = row.coord_verified === 'true' ? 'x' : ' ';
    const override = overrides.get(row.wolfari_key);
    const overrideNote = override
      ? ` · **override**: ${override.lat ? `${override.lat}, ${override.lon}` : 'giữ ghim'}${override.coord_verified !== undefined ? `, coord_verified=${override.coord_verified}` : ''}${override.note ? ` (${override.note})` : ''}`
      : '';
    if (!has(row))
      return [
        `- [${checked}] **${row.wolfari_key}** — ${row.name_vi} (${row.category}) — ⚠ chưa có tọa độ — [Tìm trên OSM](${searchLink(`${row.name_vi} Đà Nẵng`)})${overrideNote}`,
      ];
    const match = cachedMatch(row, cache);
    const osm = match
      ? ` · OSM: "${match.results[0].display_name}" (${match.results[0].category}/${match.results[0].type})`
      : '';
    const via =
      match && match.usedQuery !== row.name_vi
        ? ` · ⚠ khớp theo truy vấn "${match.usedQuery}"`
        : '';
    const note = row.notes ? ` · ghi chú: ${row.notes}` : '';
    const out = [
      `- [${checked}] **${row.wolfari_key}** — ${row.name_vi} (${row.category}) — ${row.lat}, ${row.lon} · ${row.coord_source || '?'} ${row.osm_ref} — [Bản đồ](${osmLink(row.lat, row.lon)})${osm}${via}${note}${overrideNote}`,
    ];
    if (match)
      for (const other of match.results.slice(1)) {
        const lat = Number(other.lat).toFixed(6);
        const lon = Number(other.lon).toFixed(6);
        out.push(
          `  - kết quả Nominatim khác: ${lat}, ${lon} · ${other.osm_type}/${other.osm_id} · ${other.display_name} — [Bản đồ](${osmLink(lat, lon)})`,
        );
      }
    return out;
  };

  if (candidates?.targets) {
    const targets = Object.entries(candidates.targets);
    lines.push(`## Cần quyết định (${targets.length} điểm)`, '');
    lines.push(
      `Ứng viên lấy từ OpenStreetMap lúc ${candidates.generated_at} (\`scripts/poi/find-candidates.mjs\`): tối đa 3 mỗi điểm, xếp theo mức khớp tên/tag rồi khoảng cách — **chưa ai xác minh**, thứ tự không có nghĩa là đúng.`,
      '',
    );
    for (const [group, title] of GROUPS) {
      const inGroup = targets.filter(([, t]) => t.group === group);
      if (!inGroup.length) continue;
      lines.push(`### ${title} (${inGroup.length})`, '');
      for (const [key, target] of inGroup) {
        const row = byKey.get(key);
        if (!row) continue;
        lines.push(...rowLine(row));
        if (target.goal) lines.push(`  - cần tìm: ${target.goal}`);
        if (target.overpass_error)
          lines.push(
            `  - ⚠ Overpass lỗi khi tìm (${target.overpass_error}) — chỉ có ứng viên Nominatim; chạy lại \`corepack pnpm poi:candidates\` để bổ sung.`,
          );
        if (target.candidates.length) lines.push(...target.candidates.map(candidateLine));
        else
          lines.push(
            '  - Không tìm thấy ứng viên phù hợp trong OSM — cần nhập tay (bấm "Tìm trên OSM" hoặc lấy tọa độ trên bản đồ).',
          );
        lines.push('');
      }
    }
  }
  lines.push(`## Toàn bộ ${records.length} điểm`, '');
  for (const row of records) lines.push(...rowLine(row));
  lines.push('');
  await writeFile(file.review, lines.join('\n'));
  return { review: file.review, overrides: overrides.size, overrideErrors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const csvPath = resolve(
    root,
    args.includes('--csv') ? args[args.indexOf('--csv') + 1] : 'data/poi/danang_golden.csv',
  );
  const result = await writeReview(csvPath);
  console.log(
    `Review: ${result.review} · override đang dùng: ${result.overrides}${result.overrideErrors.length ? ` · LỖI override: ${result.overrideErrors.length}` : ''}`,
  );
}
