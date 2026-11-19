#!/usr/bin/env node
// List 1–3 OpenStreetMap candidates for golden-list points that need a human decision
// (not found, matched the wrong object, or pinned at an area centre). Candidates are written to
// data/poi/danang_golden.candidates.json and shown in the review file; the golden CSV is NOT
// changed — the reviewer copies a chosen coordinate into danang_golden.overrides.csv.
// Usage: node --env-file=.env scripts/poi/find-candidates.mjs [--dns 1.1.1.1,8.8.8.8]
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, serializeCsv } from './csv.mjs';
import { createOsmClient, dnsServersFrom } from './osm.mjs';
import { DANANG_BBOX, OVERRIDE_HEADER, overrideTemplate } from './overrides.mjs';
import { paths, writeReview } from './review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const csvPath = resolve(root, 'data/poi/danang_golden.csv');

// Overpass tag filters (QL) and the matching JS checks used for ranking.
const ENTRY = {
  clauses: [
    '["entrance"~"main|yes"]["name"]',
    '["entrance"="main"]',
    '["barrier"="gate"]["name"]',
    '["shop"="ticket"]',
    '["amenity"="ticket_validator"]',
    '["tourism"="information"]["name"]',
  ],
  want: (t) =>
    Boolean(
      t.entrance ||
      t.barrier === 'gate' ||
      t.shop === 'ticket' ||
      t.amenity === 'ticket_validator' ||
      t.tourism === 'information',
    ),
};
const FERRY = {
  clauses: ['["amenity"="ferry_terminal"]', '["man_made"="pier"]["name"]', '["leisure"="marina"]'],
  want: (t) => t.amenity === 'ferry_terminal' || t.man_made === 'pier' || t.leisure === 'marina',
};
const BEACH = {
  clauses: ['["natural"="beach"]', '["leisure"="beach_resort"]'],
  want: (t) => t.natural === 'beach' || t.leisure === 'beach_resort',
};
const TREE = { clauses: ['["natural"="tree"]["name"]'], want: (t) => t.natural === 'tree' };
const REEF = {
  clauses: ['["natural"~"reef|bare_rock|rock|cape|beach"]["name"]'],
  want: (t) => /^(reef|bare_rock|rock|cape|beach)$/.test(t.natural ?? ''),
};
const THEME = {
  clauses: ['["tourism"="theme_park"]', '["attraction"]["name"]'],
  want: (t) => t.tourism === 'theme_park' || Boolean(t.attraction),
  weight: 1, // rides/attractions rank below gates and ticket offices
};
/** Tag score of a kind: weight (default 3) when its tags match. */
const kindScore = (kind, tags) =>
  kind.score ? kind.score(tags) : kind.want(tags) ? (kind.weight ?? 3) : 0;
const merge = (...kinds) => ({
  clauses: kinds.flatMap((k) => k.clauses),
  score: (t) => Math.max(...kinds.map((k) => kindScore(k, t))),
});
/** Hotels, cafés, shops… share names with places but are never an entrance/beach/pier. */
const commercial = (t) =>
  /^(cafe|restaurant|bar|pub|fast_food|ice_cream|bank|atm|pharmacy|fuel|car_rental)$/.test(
    t.amenity ?? '',
  ) ||
  /^(hotel|guest_house|hostel|motel|apartment|chalet)$/.test(t.tourism ?? '') ||
  Boolean(t.shop && t.shop !== 'ticket') ||
  Boolean(t.office) ||
  t.building === 'house';

/** near: 'self' = current pin of the row; another wolfari_key = that row's pin; box = [s,w,n,e] search area. */
const TARGETS = [
  {
    key: 'dn-cau-tinh-yeu',
    group: 'missing',
    goal: 'cầu tàu khóa tình yêu bờ đông sông Hàn',
    queries: [
      'Cầu Tình Yêu Đà Nẵng',
      'Love Lock Bridge Da Nang',
      'Cầu tàu Tình Yêu',
      'Love Bridge Da Nang',
    ],
    near: 'dn-cau-rong',
    radius: 1500,
    name: 'Tình Yêu|tình yêu|Love|love',
    kind: { clauses: [], want: () => false },
  },
  {
    key: 'dn-nha-co-tan-ky',
    group: 'missing',
    goal: 'nhà cổ Tấn Ký, 101 Nguyễn Thái Học, phố cổ Hội An',
    queries: ['Tan Ky Old House', 'Nhà cổ Tấn Ký Hội An', 'Tấn Ký', 'Tan Ky House Hoi An'],
    near: 'dn-pho-co-hoi-an',
    radius: 1500,
    name: 'Tấn Ký|Tan Ky|Tân Ký|Tấn Kí',
    kind: { clauses: [], want: () => false },
  },
  {
    key: 'dn-bien-pham-van-dong',
    group: 'missing',
    goal: 'bãi tắm công cộng cuối đường Phạm Văn Đồng',
    queries: [
      'Pham Van Dong Beach',
      'Bãi tắm Phạm Văn Đồng',
      'Bãi biển Phạm Văn Đồng Đà Nẵng',
      'Phạm Văn Đồng beach Da Nang',
    ],
    near: 'dn-bien-my-khe',
    radius: 3000,
    name: 'Phạm Văn Đồng|Pham Van Dong',
    kind: BEACH,
  },
  {
    key: 'dn-hoa-phu-thanh',
    group: 'missing',
    goal: 'khu du lịch sinh thái/vượt thác Hòa Phú Thành (Hòa Vang)',
    queries: [
      'Hoa Phu Thanh',
      'Hòa Phú Thành',
      'Khu du lịch sinh thái Hòa Phú Thành',
      'Hoa Phu Thanh rafting',
    ],
    box: [15.85, 107.75, 16.15, 108.15], // Hòa Vang search area

    name: 'Hòa Phú Thành|Hoà Phú Thành|Hoa Phu Thanh',
    kind: { clauses: [], want: () => false },
  },
  {
    key: 'dn-cay-da-nghin-nam',
    group: 'missing',
    goal: 'cây đa di sản trên bán đảo Sơn Trà',
    queries: [
      'cây đa Sơn Trà',
      'Cây đa ngàn năm Sơn Trà',
      'Thousand Year Old Banyan Tree',
      'Banyan Tree Son Tra',
      'Cây đa di sản Sơn Trà',
    ],
    near: 'dn-ban-dao-son-tra',
    radius: 5000,
    name: '[Cc]ây [Đđ]a|[Bb]anyan|[Nn]gàn năm|[Nn]ghìn năm',
    kind: TREE,
  },
  {
    key: 'dn-bien-an-bang',
    group: 'mismatch',
    goal: 'bãi biển An Bàng (lối xuống biển/bãi xe), không phải quán cà phê',
    queries: ['Bãi biển An Bàng', 'Bãi tắm An Bàng', 'An Bang Beach Hoi An'],
    near: 'self',
    radius: 1500,
    name: 'An Bàng|An Bang',
    kind: BEACH,
  },
  {
    key: 'dn-sun-world-danang-wonders',
    group: 'mismatch',
    goal: 'cổng chính/quầy vé Sun World Danang Wonders (Asia Park cũ)',
    queries: [
      'Sun World Danang Wonders',
      'Sun World Đà Nẵng Wonders',
      'Công viên Châu Á Đà Nẵng',
      'Asia Park Da Nang',
      'Sun Wheel Da Nang',
      'Vòng quay Mặt Trời',
    ],
    near: 'self',
    radius: 1200,
    name: 'Sun World|Asia Park|Châu Á|Sun Wheel|Mặt Trời|Wonders',
    kind: merge(ENTRY, THEME),
  },
  {
    key: 'dn-ran-nam-o',
    group: 'mismatch',
    goal: 'ghềnh/rạn đá ven biển Nam Ô, không phải tổ dân phố',
    queries: ['Rạn Nam Ô', 'Ghềnh Nam Ô', 'Nam O Reef', 'Bãi đá Nam Ô', 'Rạn đá Nam Ô'],
    near: 'self',
    radius: 2000,
    name: 'Rạn|Ghềnh|Nam Ô|Nam O',
    kind: REEF,
  },
  {
    key: 'dn-rung-dua-bay-mau',
    group: 'mismatch',
    goal: 'bến thuyền thúng rừng dừa Bảy Mẫu, không phải tên đường',
    queries: [
      'Rừng dừa Bảy Mẫu',
      'Bay Mau Coconut Forest',
      'Rừng dừa Cẩm Thanh',
      'Bến thuyền thúng Bảy Mẫu',
      'Coconut forest Hoi An',
    ],
    near: 'self',
    radius: 2000,
    name: 'Bảy Mẫu|Bay Mau|[Tt]huyền thúng|[Bb]asket [Bb]oat|[Cc]oconut|[Rr]ừng dừa',
    kind: FERRY,
  },
  {
    key: 'dn-ngu-hanh-son',
    group: 'center',
    goal: 'cổng bán vé chính (Thủy Sơn) hoặc thang máy',
    queries: [
      'Cổng Ngũ Hành Sơn',
      'Quầy vé Ngũ Hành Sơn',
      'Marble Mountains ticket office',
      'Thủy Sơn Ngũ Hành Sơn',
      'Thang máy Ngũ Hành Sơn',
    ],
    near: 'self',
    radius: 900,
    name: '[Vv]é|[Cc]ổng|[Tt]icket|[Gg]ate|[Ee]ntrance|[Tt]hang máy|[Ee]levator|Thủy Sơn',
    kind: ENTRY,
  },
  {
    key: 'dn-ban-dao-son-tra',
    group: 'center',
    goal: 'lối vào bán đảo trên đường Hoàng Sa',
    queries: [
      'Cổng Bán đảo Sơn Trà',
      'Ban quản lý Bán đảo Sơn Trà',
      'Son Tra Peninsula entrance',
      'Trạm kiểm soát Sơn Trà',
    ],
    near: 'self',
    radius: 4000,
    name: '[Cc]ổng|[Tt]rạm|[Bb]an [Qq]uản [Ll]ý|[Ee]ntrance|[Gg]ate',
    kind: ENTRY,
  },
  {
    key: 'dn-cu-lao-cham',
    group: 'center',
    goal: 'bến Bãi Làng trên đảo (bến đi: Cửa Đại)',
    queries: [
      'Bến tàu Cửa Đại',
      'Cảng Cửa Đại',
      'Bãi Làng Cù Lao Chàm',
      'Bến Bãi Làng',
      'Cu Lao Cham ferry',
    ],
    near: 'self',
    radius: 4500,
    name: '[Bb]ến|[Cc]ảng|Bãi Làng|[Pp]ier|[Ff]erry|[Pp]ort',
    kind: FERRY,
  },
  {
    key: 'dn-pho-co-hoi-an',
    group: 'center',
    goal: 'quầy bán vé tham quan phố cổ',
    queries: [
      'Quầy vé phố cổ Hội An',
      'Hoi An Ancient Town ticket booth',
      'Quầy bán vé tham quan Hội An',
      'Hoi An ticket office',
    ],
    near: 'self',
    radius: 800,
    name: '[Vv]é|[Tt]icket|[Qq]uầy',
    kind: {
      clauses: ['["shop"="ticket"]', '["tourism"="information"]'],
      want: (t) => t.shop === 'ticket' || t.tourism === 'information',
    },
  },
];

const SHOWN_TAGS = [
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'natural',
  'man_made',
  'entrance',
  'barrier',
  'historic',
  'attraction',
  'place',
  'building',
];
const PLACE =
  /^(city|town|suburb|quarter|neighbourhood|village|hamlet|isolated_dwelling|locality|island|islet)$/;
const inBbox = (lat, lon) =>
  lat >= DANANG_BBOX.minLat &&
  lat <= DANANG_BBOX.maxLat &&
  lon >= DANANG_BBOX.minLon &&
  lon <= DANANG_BBOX.maxLon;
function distance(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function main() {
  const email = process.env.NOMINATIM_EMAIL?.trim();
  if (!email) {
    console.error('NOMINATIM_EMAIL chưa được đặt trong .env.');
    process.exit(2);
  }
  const osm = await createOsmClient({
    email,
    dnsServers: dnsServersFrom(process.argv.slice(2)),
    cacheDir: dirname(csvPath),
  });
  const { records } = parseCsv(await readFile(csvPath, 'utf8'));
  const byKey = new Map(records.map((r) => [r.wolfari_key, r]));
  const output = {
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    targets: {},
  };

  for (const target of TARGETS) {
    const row = byKey.get(target.key);
    if (!row) throw new Error(`Không có ${target.key} trong CSV`);
    const refRow = target.near === 'self' ? row : target.near ? byKey.get(target.near) : null;
    const ref =
      refRow?.lat && refRow?.lon ? { lat: Number(refRow.lat), lon: Number(refRow.lon) } : null;
    const refLabel =
      target.near === 'self' ? 'ghim hiện tại' : target.near ? `ghim ${target.near}` : null;
    const nameRe = new RegExp(target.name, 'u');
    const found = new Map();
    const add = (osmRef, lat, lon, name, tags, via) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inBbox(lat, lon)) return;
      if (osmRef === row.osm_ref) return; // already the current pin
      const entry = found.get(osmRef) ?? { osm: osmRef, lat, lon, name, tags, via: new Set() };
      entry.via.add(via);
      if (!entry.name && name) entry.name = name;
      found.set(osmRef, entry);
    };
    for (const query of target.queries) {
      for (const r of await osm.nominatim(query))
        add(
          `${r.osm_type}/${r.osm_id}`,
          Number(r.lat),
          Number(r.lon),
          r.display_name.split(',')[0],
          { [r.category]: r.type, _display: r.display_name },
          `Nominatim "${query}"`,
        );
    }
    const area = target.box
      ? `(${target.box.join(',')})`
      : ref
        ? `(around:${target.radius},${ref.lat},${ref.lon})`
        : null;
    let overpassError;
    if (area) {
      const clauses = [
        `["name"~"${target.name}"][!"highway"][!"boundary"][!"route"]`,
        `["name:en"~"${target.name}"][!"highway"][!"boundary"][!"route"]`,
        ...target.kind.clauses,
      ];
      const query = `[out:json][timeout:80];(${clauses.map((c) => `nwr${area}${c};`).join('')});out center tags 120;`;
      try {
        const scope = target.box ? 'vùng Hòa Vang' : `${target.radius} m quanh ${refLabel}`;
        for (const el of await osm.overpass(query)) {
          const tags = el.tags ?? {};
          if (tags.highway || tags.boundary || tags.route || tags.admin_level) continue;
          add(
            `${el.type}/${el.id}`,
            el.lat ?? el.center?.lat,
            el.lon ?? el.center?.lon,
            tags.name ?? tags['name:vi'] ?? tags['name:en'] ?? '',
            tags,
            `Overpass (${scope})`,
          );
        }
      } catch (error) {
        overpassError = error.message;
        console.log(
          `  ! Overpass lỗi cho ${target.key}: ${error.message} — chỉ dùng kết quả Nominatim`,
        );
      }
    }
    const ranked = [...found.values()]
      .map((c) => {
        const names = [c.name, c.tags.name, c.tags['name:en'], c.tags['name:vi'], c.tags._display]
          .filter(Boolean)
          .join(' | ');
        const score =
          kindScore(target.kind, c.tags) +
          (nameRe.test(names) ? 2 : 0) +
          ([...c.via].some((v) => v.startsWith('Nominatim')) ? 1 : 0) -
          (PLACE.test(c.tags.place ?? '') ? 3 : 0) -
          (commercial(c.tags) ? 3 : 0);
        return {
          ...c,
          score,
          distance_m: ref ? distance(ref.lat, ref.lon, c.lat, c.lon) : undefined,
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || (a.distance_m ?? 0) - (b.distance_m ?? 0))
      .slice(0, 3)
      .map((c) => ({
        lat: c.lat.toFixed(6),
        lon: c.lon.toFixed(6),
        osm: c.osm,
        name: c.name,
        tags: SHOWN_TAGS.filter((k) => c.tags[k]).map((k) => `${k}=${c.tags[k]}`),
        found_by: [...c.via].join(' + '),
        ...(c.distance_m !== undefined
          ? { distance_m: Math.round(c.distance_m), distance_from: refLabel }
          : {}),
      }));
    output.targets[target.key] = {
      group: target.group,
      goal: target.goal,
      queries: target.queries,
      ...(overpassError ? { overpass_error: overpassError } : {}),
      candidates: ranked,
    };
    console.log(
      `${ranked.length ? 'OK  ' : 'NONE'} ${target.key}: ${ranked.length} ứng viên${ranked.length ? ' — ' + ranked.map((c) => `"${c.name}" ${c.osm}`).join(' | ') : ''}`,
    );
  }

  const file = paths(csvPath);
  await writeFile(file.candidates, `${JSON.stringify(output, null, 2)}\n`);
  if (!existsSync(file.overrides)) {
    await writeFile(file.overrides, serializeCsv([...OVERRIDE_HEADER], overrideTemplate(records)));
    console.log(`Tạo mẫu override: ${file.overrides}`);
  }
  const review = await writeReview(csvPath);
  console.log(`Ứng viên: ${file.candidates}\nReview: ${review.review}`);
}

await main();
