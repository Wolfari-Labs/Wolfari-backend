#!/usr/bin/env node
// POI-IMAGES pipeline (docs/architecture/poi-images.md). Steps share one work dir per batch:
//   pull     POIs of the active snapshot + OSM tags + Wikidata items around them
//   harvest  link POIs ↔ Wikidata, gather candidate files (P18, Wikipedia lead, Commons category,
//            OSM tags, Commons geosearch) and their licence metadata
//   select   score candidates, choose hero + gallery (pure rules in lib.mjs)
//   load     download only the chosen photos, store WebP 320/640/1280 in MinIO, write poi_media
//   gates    coverage / licence / source report (reports only)
//   activate make --batch the only active batch (switch or roll back)
//   all      pull → harvest → select → load → gates
// Usage: node scripts/poi/images/run.mjs <step> [--env <travel .env>] [--batch <id>] [--province <code>]
//        [--tiers golden|all] [--activate]
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readEnv, root } from '../../config.mjs';
import { safeError } from '../../migrations.mjs';
import { parseCsv } from '../csv.mjs';
import { DEFAULT_ENV, connectTravel, travelUrl } from '../poi-db.mjs';
import { COMMONS_API, USER_AGENT, createHttp, mediawiki, wikipediaApi } from './http.mjs';
import {
  attributionLine, cellCircle, cellsFor, distanceMeters, linkEntities, matchRadius, normalizeAuthor, normalizeLicense,
  plainText, scoreCandidate, selectPhotos, splitCell, HERO_THRESHOLD, GALLERY_THRESHOLD,
} from './lib.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string', default: DEFAULT_ENV },
    batch: { type: 'string' },
    province: { type: 'string' },
    tiers: { type: 'string', default: 'golden' },
    activate: { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
  },
});
const step = positionals[0];
const batch = args.batch ?? `img-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
if (!/^[a-z0-9-]{4,40}$/.test(batch)) throw new Error('--batch: 4–40 ký tự a-z, 0-9, "-".');
const work = resolve(root, '.local/poi/images', batch);
const http = createHttp(resolve(root, '.local/poi/images/cache'), { log: console.log });
const save = async (name, value) => {
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, name), JSON.stringify(value, null, 1));
};
const load = async (name) => JSON.parse(await readFile(resolve(work, name), 'utf8'));
const BUCKET = 'wolfari-poi-images';
/** Database errors may carry connection details; HTTP/pipeline messages are safe to print. */
const explain = (error) => (error?.code || /postgres(ql)?:\/\//.test(String(error?.message)) ? safeError(error) : String(error?.message ?? error));
const WIDTHS = [320, 640, 1280];

// ---------------------------------------------------------------- pull
async function pull() {
  const client = await connectTravel(await travelUrl(args.env), { statementTimeout: '5min' });
  let pois;
  try {
    const snapshot = (await client.query('SELECT id, version FROM poi_snapshots WHERE is_active')).rows[0];
    if (!snapshot) throw new Error('Chưa có snapshot POI đang hoạt động.');
    pois = (
      await client.query(
        `SELECT p.wolfari_key, p.tier, p.name_vi, p.name_en, p.aliases, p.category,
           p.latitude::float8 AS latitude, p.longitude::float8 AS longitude, p.coord_pileup, p.province_code,
           coalesce(array_agg(s.source_id ORDER BY s.source_id) FILTER (WHERE s.source = 'overture'), '{}') AS gers,
           max(s.source_id) FILTER (WHERE s.source = 'osm') AS osm_ref
         FROM pois p LEFT JOIN poi_sources s ON s.poi_id = p.id
         WHERE p.snapshot_id = $1 AND ($2::text IS NULL OR p.province_code = $2)
           AND ($3 OR p.tier IN (1, 2, 3))
         GROUP BY p.id ORDER BY p.tier, p.wolfari_key`,
        [snapshot.id, args.province ?? null, args.tiers === 'all'],
      )
    ).rows.map((row) => ({
      ...row,
      // Media follow stable ids: golden key for curated POIs, first GERS id for Overture POIs.
      key: row.tier <= 3 ? row.wolfari_key : row.gers[0],
      kind: row.tier <= 3 ? 'golden' : 'overture',
    })).filter((poi) => poi.key);
    console.log(`POI: ${pois.length} (snapshot ${snapshot.version})`);
  } finally {
    await client.end();
  }
  // OSM tags for curated POIs (osm_ref = "way/123"): wikidata, wikimedia_commons, image.
  const osm = {};
  for (const poi of pois.filter((p) => /^(node|way|relation)\/\d+$/.test(p.osm_ref ?? ''))) {
    try {
      const body = await http.json(`https://api.openstreetmap.org/api/0.6/${poi.osm_ref}.json`);
      const tags = body.elements?.[0]?.tags ?? {};
      osm[poi.key] = { wikidata: tags.wikidata, commons: tags.wikimedia_commons, image: tags.image };
    } catch (error) {
      console.log(`  OSM ${poi.osm_ref}: ${explain(error)}`);
    }
  }
  console.log(`OSM: ${Object.keys(osm).length} thẻ, ${Object.values(osm).filter((t) => t.wikidata).length} có wikidata`);
  // Wikidata items with coordinates in the cells that hold a POI.
  const items = new Map();
  const cells = cellsFor(pois, 0.1);
  for (const [i, cell] of cells.entries()) {
    for (const item of await wikidataBox(cell)) items.set(item.qid, item);
    if (i % 10 === 9) console.log(`  Wikidata ô ${i + 1}/${cells.length}: ${items.size} mục`);
  }
  const tagged = [...new Set(Object.values(osm).map((t) => t.wikidata).filter((q) => q && !items.has(q)))];
  for (const item of await wikidataItems(tagged)) items.set(item.qid, item);
  console.log(`Wikidata: ${items.size} mục có tọa độ`);
  await save('pois.json', pois);
  await save('osm.json', osm);
  await save('items.json', [...items.values()]);
}

const ITEM_FIELDS = `(SAMPLE(?c) AS ?coord) (SAMPLE(?lvi) AS ?label_vi) (SAMPLE(?len) AS ?label_en)
  (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?p31), "entity/"); separator="|") AS ?types)
  (SAMPLE(?img) AS ?image) (SAMPLE(?cat) AS ?commons_cat) (SAMPLE(?wvi) AS ?wiki_vi) (SAMPLE(?wen) AS ?wiki_en)`;
const ITEM_OPTIONALS = `OPTIONAL { ?item rdfs:label ?lvi FILTER(LANG(?lvi) = "vi") }
  OPTIONAL { ?item rdfs:label ?len FILTER(LANG(?len) = "en") }
  OPTIONAL { ?item skos:altLabel ?alias FILTER(LANG(?alias) IN ("vi", "en")) }
  OPTIONAL { ?item wdt:P31 ?p31 }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P373 ?cat }
  OPTIONAL { ?wvi schema:about ?item ; schema:isPartOf <https://vi.wikipedia.org/> }
  OPTIONAL { ?wen schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }`;
function parseItems(body) {
  const value = (row, key) => row[key]?.value;
  return (body.results?.bindings ?? []).flatMap((row) => {
    const coord = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(value(row, 'coord') ?? '');
    const qid = /Q\d+$/.exec(value(row, 'item') ?? '')?.[0];
    if (!coord || !qid || (!value(row, 'label_vi') && !value(row, 'label_en'))) return [];
    const file = value(row, 'image');
    const article = (url) => (url ? decodeURIComponent(url.split('/wiki/')[1] ?? '').replace(/_/g, ' ') : undefined);
    return [{
      qid,
      latitude: Number(coord[2]),
      longitude: Number(coord[1]),
      label_vi: value(row, 'label_vi'),
      label_en: value(row, 'label_en'),
      aliases: (value(row, 'aliases') ?? '').split('|').filter(Boolean),
      p31: (value(row, 'types') ?? '').split('|').filter(Boolean),
      p18: file ? 'File:' + decodeURIComponent(file.split('/Special:FilePath/')[1] ?? '').replace(/_/g, ' ') : undefined,
      commons_category: value(row, 'commons_cat'),
      wiki_vi: article(value(row, 'wiki_vi')),
      wiki_en: article(value(row, 'wiki_en')),
    }];
  });
}
async function wikidataBox(cell) {
  const query = `SELECT ?item ${ITEM_FIELDS} WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?c .
    bd:serviceParam wikibase:cornerSouthWest "Point(${cell.minLon} ${cell.minLat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${cell.maxLon} ${cell.maxLat})"^^geo:wktLiteral . }
  ${ITEM_OPTIONALS}
} GROUP BY ?item`;
  return parseItems(await http.sparql(query));
}
async function wikidataItems(qids) {
  const out = [];
  for (let i = 0; i < qids.length; i += 100) {
    const values = qids.slice(i, i + 100).map((q) => `wd:${q}`).join(' ');
    const query = `SELECT ?item ${ITEM_FIELDS} WHERE { VALUES ?item { ${values} } ?item wdt:P625 ?c . ${ITEM_OPTIONALS} } GROUP BY ?item`;
    out.push(...parseItems(await http.sparql(query)));
  }
  return out;
}

// ---------------------------------------------------------------- harvest
async function harvest() {
  const pois = await load('pois.json');
  const osm = await load('osm.json');
  const items = await load('items.json');
  const osmWikidata = new Map(Object.entries(osm).flatMap(([key, tags]) => (tags.wikidata ? [[key, tags.wikidata]] : [])));
  const links = linkEntities(pois, items, { osmWikidata });
  console.log(`Liên kết Wikidata: ${links.length}/${pois.length} POI`);
  const linkByKey = new Map(links.map((l) => [l.poi.key, l]));
  /** key → [{ title, evidence }] */
  const candidates = new Map(pois.map((p) => [p.key, []]));
  const add = (key, title, evidence) => {
    if (!title?.startsWith('File:')) return;
    candidates.get(key)?.push({ title: title.replace(/_/g, ' '), evidence });
  };

  // S1: manual picks win over everything (data/poi/image_overrides.csv: key,commons_file).
  for (const row of await manualOverrides()) add(row.key, row.commons_file.startsWith('File:') ? row.commons_file : `File:${row.commons_file}`, { kind: 'manual' });
  // S3: OSM file tags.
  for (const [key, tags] of Object.entries(osm)) {
    if (tags.commons?.startsWith('File:')) add(key, tags.commons, { kind: 'osm_file' });
    const fromImage = /commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/.exec(tags.image ?? '')?.[1];
    if (fromImage) add(key, decodeURIComponent(fromImage), { kind: 'osm_file' });
  }
  // S2: P18, Wikipedia lead images, Commons categories of linked items (+ OSM category tags).
  const categories = new Map();
  const articles = { vi: new Map(), en: new Map() };
  for (const link of links) {
    const item = link.item ?? items.find((i) => i.qid === link.qid);
    if (!item) continue;
    if (item.p18) add(link.poi.key, item.p18, { kind: 'p18' });
    if (item.commons_category) categories.set(link.poi.key, [...(categories.get(link.poi.key) ?? []), `Category:${item.commons_category}`]);
    if (item.wiki_vi) articles.vi.set(item.wiki_vi, link.poi.key);
    if (item.wiki_en) articles.en.set(item.wiki_en, link.poi.key);
  }
  for (const [key, tags] of Object.entries(osm)) {
    if (tags.commons?.startsWith('Category:') && linkByKey.has(key)) categories.set(key, [...(categories.get(key) ?? []), tags.commons]);
  }
  for (const lang of ['vi', 'en']) {
    const titles = [...articles[lang].keys()];
    for (let i = 0; i < titles.length; i += 50) {
      const pages = await mediawiki(http, wikipediaApi(lang), { action: 'query', prop: 'pageimages', piprop: 'name', redirects: '1', titles: titles.slice(i, i + 50).join('|') });
      for (const body of pages) {
        const back = new Map([...(body.query?.normalized ?? []), ...(body.query?.redirects ?? [])].map((n) => [n.to, n.from]));
        for (const page of body.query?.pages ?? []) {
          const original = back.get(page.title) ?? page.title;
          const key = articles[lang].get(original) ?? articles[lang].get(back.get(original) ?? '');
          if (key && page.pageimage) add(key, `File:${page.pageimage}`, { kind: 'lead' });
        }
      }
    }
  }
  for (const [key, list] of categories) {
    for (const category of [...new Set(list)]) {
      const [body] = await mediawiki(http, COMMONS_API, { action: 'query', list: 'categorymembers', cmtitle: category, cmtype: 'file', cmlimit: '50' }, { max: 1 });
      for (const member of body.query?.categorymembers ?? []) add(key, member.title, { kind: 'category' });
    }
  }
  // S4: Commons files with coordinates near each POI (geosearch per cell, split when full).
  const geo = await geosearchFiles(pois);
  for (const poi of pois) {
    if (poi.coord_pileup) continue; // centroid coordinates: distance means nothing
    const radius = matchRadius(poi.category);
    for (const file of geo) {
      const d = distanceMeters(poi.latitude, poi.longitude, file.lat, file.lon);
      if (d <= radius) add(poi.key, file.title, { kind: 'geo', distance: Math.round(d) });
    }
  }
  const titles = [...new Set([...candidates.values()].flat().map((c) => c.title))];
  console.log(`Ứng viên: ${[...candidates.values()].flat().length} (${titles.length} tệp khác nhau) · geosearch ${geo.length} tệp`);
  const infos = await imageInfo(titles);
  console.log(`Metadata: ${Object.keys(infos).length} tệp`);
  await save('links.json', links.map((l) => ({ key: l.poi.key, kind: l.poi.kind, qid: l.qid, score: l.score, method: l.method, commons_category: l.item?.commons_category, wiki_vi: l.item?.wiki_vi, wiki_en: l.item?.wiki_en })));
  await save('candidates.json', Object.fromEntries(candidates));
  await save('infos.json', infos);
}
async function manualOverrides() {
  try {
    const { records } = parseCsv(await readFile(resolve(root, 'data/poi/image_overrides.csv'), 'utf8'));
    return records.filter((r) => r.key && r.commons_file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function geosearchFiles(pois) {
  const found = new Map();
  // Small cells and 100-row pages keep each geosearch cheap for Commons (large ones get throttled).
  const queue = cellsFor(pois.filter((p) => !p.coord_pileup), 0.02).map((cell) => ({ cell, depth: 0 }));
  while (queue.length) {
    const { cell, depth } = queue.shift();
    const circle = cellCircle(cell);
    const [body] = await mediawiki(http, COMMONS_API, {
      action: 'query', list: 'geosearch', gsnamespace: '6', gslimit: '100',
      gscoord: `${circle.latitude}|${circle.longitude}`, gsradius: String(circle.radius),
    }, { max: 1, gapMs: 8000 }); // geosearch is CirrusSearch-backed and throttled hard
    const rows = body.query?.geosearch ?? [];
    if (rows.length >= 100 && depth < 3) {
      queue.push(...splitCell(cell).map((c) => ({ cell: c, depth: depth + 1 })));
      continue;
    }
    for (const row of rows) found.set(row.title, { title: row.title, lat: row.lat, lon: row.lon });
  }
  return [...found.values()];
}
async function imageInfo(titles) {
  const infos = {};
  for (let i = 0; i < titles.length; i += 50) {
    const pages = await mediawiki(http, COMMONS_API, {
      action: 'query', titles: titles.slice(i, i + 50).join('|'), redirects: '1',
      prop: 'imageinfo|categories', cllimit: 'max',
      iiprop: 'url|size|mime|sha1|extmetadata', iiurlwidth: '1280',
      iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription|AttributionRequired|UsageTerms|ObjectName',
    }, { max: 20 });
    const aliases = new Map();
    for (const body of pages) {
      for (const n of [...(body.query?.normalized ?? []), ...(body.query?.redirects ?? [])]) aliases.set(n.from, n.to);
      for (const page of body.query?.pages ?? []) {
        const entry = (infos[page.title] ??= { title: page.title, categories: [] });
        entry.categories.push(...(page.categories ?? []).map((c) => c.title.replace(/^Category:/, '')));
        const ii = page.imageinfo?.[0];
        if (!ii) continue;
        const meta = Object.fromEntries(Object.entries(ii.extmetadata ?? {}).map(([k, v]) => [k, v?.value]));
        Object.assign(entry, {
          width: ii.width, height: ii.height, mime: ii.mime, sha1: ii.sha1,
          url: ii.url, thumburl: ii.thumburl, thumbwidth: ii.thumbwidth, thumbheight: ii.thumbheight,
          page: ii.descriptionurl, meta,
          author: normalizeAuthor(meta.Artist) ?? normalizeAuthor(meta.Credit),
          description: plainText(meta.ImageDescription).slice(0, 500),
        });
      }
    }
    for (const [from, to] of aliases) if (infos[to] && !infos[from]) infos[from] = infos[to];
    if (i % 500 === 450) console.log(`  metadata ${i + 50}/${titles.length}`);
  }
  return infos;
}

// ---------------------------------------------------------------- select
async function select() {
  const pois = await load('pois.json');
  const links = new Map((await load('links.json')).map((l) => [l.key, l]));
  const candidates = await load('candidates.json');
  const infos = await load('infos.json');
  const selection = [];
  const rejected = { license: 0, metadata: 0 };
  for (const poi of pois) {
    const scored = [];
    for (const { title, evidence } of candidates[poi.key] ?? []) {
      const info = infos[title];
      if (!info?.mime) { rejected.metadata++; continue; }
      const license = normalizeLicense(info.meta);
      if (!license) { rejected.license++; continue; }
      scored.push({ info, evidence, license, score: scoreCandidate(poi, info, evidence, { link: links.get(poi.key) }) });
    }
    // The same file may arrive by several routes: keep its best-scoring route.
    const best = new Map();
    for (const c of scored) if (!best.has(c.info.title) || best.get(c.info.title).score.final < c.score.final) best.set(c.info.title, c);
    const { hero, gallery } = selectPhotos([...best.values()]);
    selection.push({ key: poi.key, kind: poi.kind, name: poi.name_vi, category: poi.category, tier: poi.tier, candidates: best.size, hero: hero && pick(hero), gallery: gallery.map(pick) });
  }
  const heroes = selection.filter((s) => s.hero).length;
  console.log(`Chọn ảnh: ${heroes}/${pois.length} POI có hero · ${selection.reduce((n, s) => n + s.gallery.length, 0)} ảnh gallery · loại ${rejected.license} vì giấy phép, ${rejected.metadata} thiếu metadata`);
  await save('selection.json', selection);
}
function pick(c) {
  return {
    title: c.info.title, page: c.info.page, thumburl: c.info.thumburl, width: c.info.width, height: c.info.height,
    author: normalizeAuthor(c.info.author), license: c.license, license_url: c.info.meta?.LicenseUrl, evidence: c.evidence.kind,
    distance: c.evidence.distance, source: c.score.source, match: c.score.match, quality: c.score.quality, final: c.score.final,
  };
}

// ---------------------------------------------------------------- load
async function store() {
  const selection = await load('selection.json');
  const links = await load('links.json');
  const env = await readEnv(resolve(args.env));
  const [host, port] = (env.MINIO_ENDPOINT ?? '').split(':');
  if (!host || !port || !env.MINIO_ACCESS_KEY || !env.MINIO_SECRET_KEY)
    throw new Error(`Thiếu MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY trong ${args.env}; chạy pnpm env:init.`);
  const require = createRequire(import.meta.url);
  const { Client } = require('minio');
  // sharp is a dependency of the services; reuse it instead of adding one at the root.
  const sharp = createRequire(resolve(root, 'apps/finance-service/package.json'))('sharp');
  const minio = new Client({ endPoint: host, port: Number(port), useSSL: false, accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY });
  if (!(await minio.bucketExists(BUCKET))) await minio.makeBucket(BUCKET);
  const rows = [];
  const photos = selection.flatMap((s) => [...(s.hero ? [{ s, photo: s.hero, role: 'hero', rank: 0 }] : []), ...s.gallery.map((photo, i) => ({ s, photo, role: 'gallery', rank: i + 1 }))]);
  const stored = new Map();
  for (const [i, { s, photo, role, rank }] of photos.entries()) {
    let file = stored.get(photo.title);
    if (!file) {
      try {
        // Downloaded thumbnails are kept in the batch dir: a re-run never fetches them again.
        const cacheFile = resolve(work, 'files', createHash('sha1').update(photo.title).digest('hex') + '.bin');
        let source = await readFile(cacheFile).catch(() => null);
        if (!source) {
          source = await http.bytes(photo.thumburl);
          await mkdir(resolve(work, 'files'), { recursive: true });
          await writeFile(cacheFile, source);
        }
        const sha256 = createHash('sha256').update(source).digest('hex');
        const prefix = `poi/${sha256}`;
        let size;
        for (const width of WIDTHS) {
          const out = await sharp(source, { limitInputPixels: 60_000_000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
          await minio.putObject(BUCKET, `${prefix}/${width}.webp`, out.data, out.data.length, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
          if (width === 1280) size = out.info;
        }
        file = { sha256, prefix, width: size.width, height: size.height, bytes: size.size };
        stored.set(photo.title, file);
      } catch (error) {
        console.log(`  bỏ ${photo.title}: ${explain(error)}`);
        continue;
      }
    }
    rows.push({
      gers_id: s.kind === 'overture' ? s.key : null, golden_key: s.kind === 'golden' ? s.key : null,
      role, rank, source: photo.source, source_url: photo.page, original_url: photo.thumburl,
      storage_key: file.prefix, width: file.width, height: file.height, bytes: file.bytes, mime: 'image/webp', sha256: file.sha256,
      license_code: photo.license.code, license_url: photo.license_url ?? null, author: photo.author ?? null,
      attribution: attributionLine(photo.author, photo.license), match_method: photo.evidence,
      match_score: photo.match, quality_score: photo.quality, final_score: photo.final,
    });
    if (i % 20 === 19) console.log(`  ảnh ${i + 1}/${photos.length}`);
  }
  const client = await connectTravel(await travelUrl(args.env), { statementTimeout: '5min' });
  try {
    await client.query('BEGIN');
    const manifest = {
      created_by: 'scripts/poi/images/run.mjs', user_agent: USER_AGENT, thresholds: { hero: HERO_THRESHOLD, gallery: GALLERY_THRESHOLD },
      pois: selection.length, heroes: rows.filter((r) => r.role === 'hero').length, gallery: rows.filter((r) => r.role === 'gallery').length,
      sources: ['manual', 'wikidata', 'wikipedia', 'commons_category', 'commons_geo', 'osm_tag'],
    };
    const existing = await client.query('SELECT is_active FROM poi_media_batches WHERE id = $1', [batch]);
    if (existing.rowCount && !args.replace) throw new Error(`Batch ${batch} đã có; thêm --replace để nạp lại.`);
    // --replace: drop the old rows of this batch (cascade) and load again in the same transaction.
    if (existing.rowCount) await client.query('DELETE FROM poi_media_batches WHERE id = $1', [batch]);
    await client.query('INSERT INTO poi_media_batches(id, manifest) VALUES ($1, $2)', [batch, manifest]);
    await client.query(
      `INSERT INTO poi_media(gers_id, golden_key, role, rank, source, source_url, original_url, storage_key, width, height, bytes, mime,
         sha256, license_code, license_url, author, attribution, match_method, match_score, quality_score, final_score, batch_id, fetched_at)
       SELECT r.gers_id, r.golden_key, r.role, r.rank, r.source, r.source_url, r.original_url, r.storage_key, r.width, r.height, r.bytes, r.mime,
         r.sha256, r.license_code, r.license_url, r.author, r.attribution, r.match_method, r.match_score, r.quality_score, r.final_score, $2, now()
       FROM jsonb_to_recordset($1::jsonb) AS r(gers_id text, golden_key text, role text, rank int, source text, source_url text, original_url text,
         storage_key text, width int, height int, bytes int, mime text, sha256 text, license_code text, license_url text, author text,
         attribution text, match_method text, match_score numeric, quality_score numeric, final_score numeric)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows), batch],
    );
    const entityRows = links.flatMap((l) => [
      { scheme: 'wikidata', value: l.qid },
      ...(l.commons_category ? [{ scheme: 'commons_category', value: l.commons_category }] : []),
      ...(l.wiki_vi ? [{ scheme: 'wikipedia_vi', value: l.wiki_vi }] : []),
      ...(l.wiki_en ? [{ scheme: 'wikipedia_en', value: l.wiki_en }] : []),
    ].map((e) => ({ ...e, gers_id: l.kind === 'overture' ? l.key : null, golden_key: l.kind === 'golden' ? l.key : null, method: l.method, score: Math.round(l.score * 1000) / 1000 })));
    await client.query(
      `INSERT INTO poi_entity_links(gers_id, golden_key, scheme, value, method, score, batch_id)
       SELECT gers_id, golden_key, scheme, value, method, score, $2 FROM jsonb_to_recordset($1::jsonb)
         AS e(gers_id text, golden_key text, scheme text, value text, method text, score numeric)`,
      [JSON.stringify(entityRows), batch],
    );
    if (args.activate) {
      await client.query('UPDATE poi_media_batches SET is_active = false WHERE is_active AND id <> $1', [batch]);
      await client.query('UPDATE poi_media_batches SET is_active = true WHERE id = $1', [batch]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
  console.log(`Đã nạp batch ${batch}: ${rows.length} ảnh (${stored.size} tệp)${args.activate ? ' · đang hoạt động' : ' · chưa kích hoạt (dùng --activate)'}`);
}

// ---------------------------------------------------------------- gates
async function gates() {
  const selection = await load('selection.json');
  const links = await load('links.json');
  const by = (f) => {
    const groups = {};
    for (const s of selection) {
      const g = (groups[f(s)] ??= { pois: 0, hero: 0 });
      g.pois++;
      if (s.hero) g.hero++;
    }
    return groups;
  };
  const heroes = selection.filter((s) => s.hero);
  const report = {
    batch,
    pois: selection.length,
    linked: links.length,
    heroes: heroes.length,
    coverage: selection.length ? Math.round((heroes.length / selection.length) * 1000) / 10 : 0,
    gallery: selection.reduce((n, s) => n + s.gallery.length, 0),
    licensed: [...heroes.map((s) => s.hero), ...selection.flatMap((s) => s.gallery)].every((p) => p.license && p.page),
    by_kind: by((s) => s.kind),
    by_category: by((s) => s.category),
    hero_sources: Object.fromEntries(Object.entries(heroes.reduce((m, s) => ({ ...m, [s.hero.evidence]: (m[s.hero.evidence] ?? 0) + 1 }), {}))),
    licenses: Object.fromEntries(Object.entries(heroes.reduce((m, s) => ({ ...m, [s.hero.license.code]: (m[s.hero.license.code] ?? 0) + 1 }), {}))),
  };
  const lines = [
    `# Ảnh POI — batch ${batch}`,
    '',
    `- POI: ${report.pois} · liên kết Wikidata: ${report.linked} · có hero: ${report.heroes} (${report.coverage}%) · ảnh gallery: ${report.gallery}`,
    `- 100% ảnh có giấy phép và link nguồn: ${report.licensed ? 'có' : 'KHÔNG'}`,
    `- Nguồn hero: ${Object.entries(report.hero_sources).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`,
    `- Giấy phép hero: ${Object.entries(report.licenses).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`,
    '',
    '## Theo loại',
    '',
    '| Loại | POI | Có hero |',
    '|---|---:|---:|',
    ...Object.entries(report.by_category).sort().map(([k, v]) => `| ${k} | ${v.pois} | ${v.hero} |`),
    '',
    '## Mẫu kiểm tra độ chính xác (đánh dấu Đúng/Sai cho từng hero)',
    '',
    '| POI | Hero | Bằng chứng | Điểm |',
    '|---|---|---|---:|',
    ...heroes.map((s) => `| ${s.name} | [${s.hero.title.replace(/\|/g, '/')}](${s.hero.page}) | ${s.hero.evidence}${s.hero.distance !== undefined ? ` ${s.hero.distance} m` : ''} | ${s.hero.final} |`),
    '',
    '## Chưa có ảnh',
    '',
    ...selection.filter((s) => !s.hero).map((s) => `- ${s.name} (${s.category}, ${s.candidates} ứng viên)`),
  ];
  const dir = resolve(root, '.local/poi/reports');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `images-${batch}.md`), lines.join('\n') + '\n');
  await writeFile(resolve(dir, `images-${batch}.json`), JSON.stringify(report, null, 1));
  console.log(lines.slice(0, 6).join('\n'));
  console.log(`Báo cáo: .local/poi/reports/images-${batch}.md`);
}

async function activate() {
  const client = await connectTravel(await travelUrl(args.env));
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT 1 FROM poi_media_batches WHERE id = $1', [batch]);
    if (!found.rowCount) throw new Error(`Không có batch ${batch}.`);
    // Two statements: the partial unique index allows only one active row at any moment.
    await client.query('UPDATE poi_media_batches SET is_active = false WHERE is_active AND id <> $1', [batch]);
    await client.query('UPDATE poi_media_batches SET is_active = true WHERE id = $1', [batch]);
    await client.query('COMMIT');
    console.log(`Batch ảnh đang hoạt động: ${batch}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

const steps = { pull, harvest, select, load: store, gates, activate };
try {
  if (step === 'all') for (const name of ['pull', 'harvest', 'select', 'load', 'gates']) { console.log(`== ${name}`); await steps[name](); }
  else if (steps[step]) await steps[step]();
  else throw new Error('Lệnh: run.mjs <pull|harvest|select|load|gates|activate|all> [--batch id] [--env travel.env] [--province code] [--tiers golden|all] [--activate]');
  console.log(`HTTP: ${http.stats.requests} request, ${http.stats.cached} từ cache, ${http.stats.retries} thử lại`);
} catch (error) {
  console.error(explain(error));
  process.exitCode = 1;
}
