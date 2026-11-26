// POI-IMAGES: pure helpers for linking POIs to Wikidata/Commons and choosing photos.
// No I/O here, so every rule below is unit-tested (scripts/poi-images.test.ts).

/** Lowercase, strip Vietnamese diacritics (đ → d) and punctuation; same folding as the catalogue. */
export function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** Like fold() but diacritics are kept (NFC), so "cờ" (flag) stays apart from "cổ" (old) and "có". */
export function lower(value) {
  return spaced(value).toLowerCase();
}
/** NFC, punctuation → single spaces, case kept (for rules that tell "my son" from "My Son"). */
function spaced(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** Whole-phrase matcher for spaced()/lower() text, where words are separated by single spaces. */
const phrases = (list) => new RegExp(`(?:^| )(?:${list.join('|')})(?= |$)`, 'u');

function trigrams(value) {
  const padded = `  ${fold(value)} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
}
/** pg_trgm-style similarity of two names after folding (0..1). */
export function similarity(a, b) {
  const x = trigrams(a), y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared);
}

export function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Taxonomy codes whose POI is an area (beach, park, theme park, old town…) or is seen from afar
 * (viewpoint, mountain pass): wider match radius.
 */
const AREA = /^(beach|theme_park|water_park|amusement_park|park|nature|nature_area|nature_reserve|national_park|mountain|island|old_town|old_quarter|historic_district|craft_village|resort|lake|bay|waterfall|cave|zoo|garden|market|stadium|university|campus|peninsula|viewpoint)$/;
export function isArea(category) {
  return AREA.test(String(category ?? ''));
}
/** How far a POI and an external item/photo may be apart (metres). */
export function matchRadius(category) {
  return isArea(category) ? 1500 : 150;
}
/** Large features (pass, peninsula, island…): the Wikidata point may sit kilometres from the pin. */
const LARGE = /^(viewpoint|mountain|island|peninsula|bay|nature_area|nature_reserve|national_park)$/;
/**
 * Farthest Wikidata link for an exact, specific name (metres). Beyond matchRadius only such a name
 * links, so a wide radius never pairs a POI with a merely similar neighbour. Points get no extra.
 */
export function exactNameRadius(category) {
  if (LARGE.test(String(category ?? ''))) return 5000;
  return isArea(category) ? 3000 : matchRadius(category);
}

/** Words that name the place in a POI (name, English name, aliases), folded, at least 4 chars. */
export function poiNames(poi) {
  return [...new Set([poi.name_vi, poi.name_en, ...(poi.aliases ?? [])].map(fold).filter((n) => n.length >= 4))];
}
/** Generic prefixes that alone do not identify a place ("chùa", "bãi biển"…). */
const GENERIC = /^(chua|bai bien|bien|cho|cau|nha tho|bao tang|cong vien|khu du lich|quan|nha hang|ca phe|cafe|beach|bridge|market|museum|park|church|pagoda|temple)$/;
/** True when a folded text mentions one of the POI's names as whole words. */
export function mentionsName(text, names) {
  const haystack = ` ${fold(text)} `;
  return names.some((name) => !GENERIC.test(name) && haystack.includes(` ${name} `));
}
/** Best name evidence between a POI and an external label (exact/contained/trigram). */
export function nameScore(poi, labels) {
  const names = poiNames(poi);
  let best = 0;
  for (const label of labels.filter(Boolean)) {
    const other = fold(label);
    if (!other) continue;
    for (const name of names) {
      if (name === other) return 1;
      const [short, long] = name.length < other.length ? [name, other] : [other, name];
      if (short.length >= 5 && !GENERIC.test(short) && ` ${long} `.includes(` ${short} `)) best = Math.max(best, 0.85);
      best = Math.max(best, similarity(name, other));
    }
  }
  return best;
}
/** True when a specific (non-generic) POI name equals a label; `primary` ignores the POI's aliases. */
export function sameName(poi, labels, { primary = false } = {}) {
  const names = poiNames(primary ? { name_vi: poi.name_vi, name_en: poi.name_en } : poi).filter((n) => !GENERIC.test(n));
  const folded = new Set(labels.filter(Boolean).map(fold));
  return names.some((name) => folded.has(name));
}

/**
 * Wikidata "instance of" (P31) families vs Wolfari categories. Unknown types are neutral; a
 * known clash (e.g. a hotel item for a museum POI) rules the link out.
 */
const P31_FAMILIES = {
  Q33506: 'museum', Q207694: 'museum', Q1007870: 'museum',
  Q40357: 'beach', Q12280: 'bridge', Q44539: 'temple', Q44613: 'temple', Q160742: 'temple', Q842402: 'temple',
  Q16970: 'church', Q2977: 'church', Q330284: 'market', Q132510: 'market', Q22698: 'park', Q194195: 'theme_park',
  Q27686: 'hotel', Q11707: 'restaurant', Q30022: 'cafe', Q8502: 'mountain', Q23442: 'island', Q34038: 'waterfall',
  Q35509: 'cave', Q43501: 'zoo', Q1107656: 'garden', Q23413: 'castle', Q570116: 'attraction', Q4989906: 'monument',
};
const CATEGORY_FAMILY = {
  museum: 'museum', beach: 'beach', bridge: 'bridge', pagoda: 'temple', temple: 'temple', church: 'church',
  market: 'market', park: 'park', theme_park: 'theme_park', amusement_park: 'theme_park', hotel: 'hotel',
  resort: 'hotel', restaurant: 'restaurant', cafe: 'cafe', mountain: 'mountain', island: 'island',
  waterfall: 'waterfall', cave: 'cave', zoo: 'zoo', garden: 'garden', water_park: 'theme_park',
};
export function typeCompatible(category, p31) {
  const want = CATEGORY_FAMILY[category];
  const have = (p31 ?? []).map((q) => P31_FAMILIES[q]).filter(Boolean);
  if (!want || !have.length || have.includes('attraction') || have.includes('monument')) return true;
  // Places that are both lodging and attraction (resorts) stay neutral.
  if (want === 'hotel' || have.includes('hotel')) return have.includes(want) || want === 'theme_park';
  return have.includes(want);
}

/**
 * POI ↔ Wikidata links. One-to-one; a POI with two close candidates is left unlinked unless exactly
 * one of them carries the POI's own name (not an alias). Large features may link up to
 * exactNameRadius by an exact name, scored below any near match (0.6–0.7).
 * Pile-up coordinates (area centroids) are linked only by an exact, unique name.
 */
export function linkEntities(pois, items, { osmWikidata = new Map() } = {}) {
  const proposals = [];
  for (const poi of pois) {
    const tagged = osmWikidata.get(poi.key);
    if (tagged) {
      const item = items.find((i) => i.qid === tagged);
      const d = item ? distanceMeters(poi.latitude, poi.longitude, item.latitude, item.longitude) : 0;
      if (!item || d <= 5000) {
        proposals.push({ poi, qid: tagged, item, score: 1, method: 'osm_tag' });
        continue;
      }
    }
    const radius = matchRadius(poi.category);
    const far = exactNameRadius(poi.category);
    const scored = [];
    for (const item of items) {
      const d = distanceMeters(poi.latitude, poi.longitude, item.latitude, item.longitude);
      const labels = [item.label_vi, item.label_en, ...(item.aliases ?? [])];
      const name = nameScore(poi, labels);
      if (poi.coord_pileup) {
        if (name === 1 && d <= 50_000) scored.push({ item, score: 0.9, method: 'exact_name' });
        continue;
      }
      if (d > far || name < 0.6 || !typeCompatible(poi.category, item.p31)) continue;
      const primary = sameName(poi, labels, { primary: true });
      if (d <= radius) {
        const proximity = 1 - d / radius;
        scored.push({ item, primary, score: Math.min(0.99, 0.6 * name + 0.3 * proximity + 0.1), method: 'geo_name' });
      } else if (sameName(poi, labels)) {
        scored.push({ item, primary, score: 0.7 - (0.1 * (d - radius)) / (far - radius), method: 'exact_name_far' });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    if (poi.coord_pileup && scored.length > 1) continue;
    let best = scored[0];
    const close = scored.filter((s) => best.score - s.score < 0.05);
    if (close.length > 1) {
      // "Đèo Hải Vân" beats "Hải Vân Quan" (an alias of the POI) at the same distance.
      const own = close.filter((s) => s.primary);
      if (own.length !== 1) continue;
      best = own[0];
    }
    proposals.push({ poi, qid: best.item.qid, item: best.item, score: best.score, method: best.method });
  }
  // One item serves one POI: keep the strongest claim.
  const byItem = new Map();
  for (const p of proposals) {
    const other = byItem.get(p.qid);
    if (!other || p.score > other.score) byItem.set(p.qid, p);
  }
  return proposals.filter((p) => byItem.get(p.qid) === p);
}

/** Allowlisted licences (decision §9.1): CC0, public domain, CC BY, CC BY-SA. */
export function normalizeLicense(meta) {
  const code = String(meta?.License ?? meta?.LicenseShortName ?? '').toLowerCase().trim();
  const short = String(meta?.LicenseShortName ?? '').trim();
  if (!code) return null;
  if (/(^|[-\s])(nc|nd)([-\s]|$)/.test(code) || /noncommercial|no deriv/i.test(short)) return null;
  if (/^cc0/.test(code) || /^cc-zero/.test(code)) return { code: 'CC0-1.0', label: 'CC0' };
  if (/^(pd|public domain)/.test(code) || /^public domain/i.test(short)) return { code: 'PD', label: 'Public domain' };
  const cc = /^cc[-\s]?by(?:[-\s]?(sa))?[-\s]?(\d(?:\.\d)?)/.exec(code);
  if (cc) {
    const version = cc[2].includes('.') ? cc[2] : `${cc[2]}.0`;
    return cc[1]
      ? { code: `CC-BY-SA-${version}`, label: `CC BY-SA ${version}` }
      : { code: `CC-BY-${version}`, label: `CC BY ${version}` };
  }
  return null; // GFDL-only, all rights reserved, unknown
}

/** Plain text from Commons extmetadata HTML (Artist, ImageDescription). */
export function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Credit name: "Unknown author Unknown author" → none; an exactly repeated name is kept once. */
export function normalizeAuthor(value) {
  let text = plainText(value);
  const half = text.length / 2;
  if (Number.isInteger(half - 0.5) && text.slice(0, half - 0.5) === text.slice(half + 0.5)) text = text.slice(0, half - 0.5);
  text = text.replace(/\s*\(talk\)\s*$/i, '').trim();
  if (!text || /^(unknown|unknown author|anonymous|không rõ|khong ro|author unknown)$/i.test(text)) return undefined;
  return text.slice(0, 200);
}

/*
 * Content rules run on lower() text (diacritics kept), never on fold(): folded, "cờ" (flag) is
 * "co" like "cổ" (phố cổ, nhà cổ), "Bàn Cờ" or "Lăng Cô", and "tiền" (money) is "tien" like
 * "Suối Tiên" or "Tiên Sa". English words have no diacritics, so they match as before. Vietnamese
 * words match in their accented form; an unaccented spelling ("ban do") is listed only when it
 * cannot be another word.
 */
/** Things that are not a picture of the place itself (maps, logos, documents, portraits…). */
const NOT_A_VIEW = phrases([
  'map', 'plan', 'diagram', 'logo', 'coat of arms', 'flag(?! tower| pole)', 'menu', 'poster', 'ticket', 'document', 'scan',
  'signature', 'portrait', 'selfie', 'screenshot', 'stamp', 'banknote', 'seal', 'icon', 'svg', 'drawing', 'sign', 'text',
  'inscription', 'under construction', 'construction site',
  'bản đồ', 'ban do', 'bando', 'sơ đồ', 'so do', 'lá cờ', 'quốc kỳ', 'quốc kì', 'quoc ky', 'cờ tổ quốc', 'vé vào cổng',
  've vao cong', 'tài liệu', 'tai lieu', 'chữ ký', 'chữ kí', 'chu ky', 'chân dung', 'chan dung', 'chụp màn hình',
  'chup man hinh', 'tem', 'tiền giấy', 'tien giay', 'tờ tiền', 'tiền xu', 'bản vẽ', 'ban ve', 'biển báo',
  'bien bao', 'biển hiệu', 'bien hieu', 'bia ký', 'bia kí', 'bia ky', 'đang xây dựng', 'dang xay dung',
  'công trường xây dựng', 'cong truong xay dung',
]);
/**
 * Building works, only in a title or category: descriptions say "được xây dựng năm 1630" (built in)
 * or "construction began in…" about perfectly good views. Bare "công trường" is also a square
 * (Công trường Lam Sơn), so only "công trường xây dựng" counts. Watermarked files (Commons
 * category "Images with watermarks") are not shown either.
 */
const NOT_A_VIEW_LABEL = phrases(['construction', 'development', 'xây dựng', 'xay dung', 'dự án', 'du an', 'watermarks?', 'watermarked']);
/**
 * "people's" (People's Committee, People's Air Force Museum) is a name, not a crowd; "Mr. X speaks
 * at the … meeting" is a person, a "meeting house" (đình) is not.
 */
const PEOPLE = phrases([
  "people(?! s(?: |$))", 'mr', 'mrs', 'meeting(?! house| hall| point)', 'portrait', 'wedding', 'crowd', 'festival participants', 'family', 'selfie', 'boys', 'girls',
  'kids', 'children', 'friends', 'couple', 'đám cưới', 'dam cuoi', 'gia đình', 'trẻ em', 'tre em', 'bạn bè', 'ban be',
  'cặp đôi', 'cap doi', 'đám đông', 'dam dong', 'những người', 'nhung nguoi', 'nhiều người', 'nhieu nguoi',
]);
/**
 * "my son", "my wife"… in the original case: lowercase relation word, not followed by a place word.
 * "Mỹ Sơn", "My Son Sanctuary", "My Son Group B" and "at my son sanctuary" are the temple complex.
 */
const OWN_PEOPLE = /(?:^| )(?:[Mm]y|[Oo]ur) (?:son|daughter|wife|husband|baby)(?= |$)(?! (?:sanctuary|temples?|towers?|groups?|ruins?|relics?|hindu|cham|champa|heritage|complex|site|valley|museum|village)(?= |$))/u;
function showsPeople(text) {
  return PEOPLE.test(lower(text)) || OWN_PEOPLE.test(spaced(text));
}
/** A wildlife/plant photo ("Rhesus macaque (Macaca mulatta) … Son Tra") shows a species, not the place. */
const SPECIES = phrases([
  'macaque', 'langur', 'douc', 'monkey(?! mountain)', 'bird', 'butterfly', 'insect', 'flower', 'orchid', 'lizard', 'snake',
  'frog', 'species', 'fauna', 'flora', 'voọc', 'chim', 'bướm', 'côn trùng', 'con trung', 'phong lan',
]); // not "khi" (also "when"), not "buom" ("buồm" is a sail), not "chìm"
const BINOMIAL = /\([A-Z][a-z]+ [a-z]{3,}( [a-z]{3,})?\)/; // genus species [subspecies]
const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);

/** Metadata-only quality 0..1 (pixels are checked again after download). */
export function qualityScore(info, { hero }) {
  if (!MIME_OK.has(info.mime)) return 0;
  const short = Math.min(info.width ?? 0, info.height ?? 0);
  const ratio = (info.width ?? 0) / Math.max(1, info.height ?? 0);
  const minimum = hero ? 800 : 600;
  if (short < minimum || ratio < 0.75 || ratio > 2.0) return 0;
  // Landscape fits cards best; 1.3–1.8 is the sweet spot.
  const shape = ratio >= 1.3 && ratio <= 1.8 ? 1 : ratio >= 1 ? 0.85 : 0.6;
  const size = Math.min(1, short / 1600);
  return Math.round((0.6 * shape + 0.4 * size) * 1000) / 1000;
}
/** 0..1 "looks like a view of the place", from title/description/categories (no vision model yet). */
export function semanticScore(info) {
  const raw = `${info.title} ${info.description ?? ''} ${(info.categories ?? []).join(' | ')}`;
  const label = lower(`${info.title} ${(info.categories ?? []).join(' | ')}`);
  if (NOT_A_VIEW.test(lower(raw)) || NOT_A_VIEW_LABEL.test(label)) return 0;
  if (BINOMIAL.test(info.title ?? '') || SPECIES.test(lower(info.title))) return 0.2;
  if (showsPeople(raw)) return 0.3;
  return /\b(view|panorama|toan canh|exterior|facade|mat tien|aerial|flycam|landscape|canh)\b/.test(fold(raw)) ? 0.8 : 0.5;
}
export function prominenceScore(info) {
  const cats = (info.categories ?? []).join('|');
  if (/Featured pictures/i.test(cats)) return 1;
  if (info.p18) return 0.8;
  if (/Quality images/i.test(cats)) return 0.7;
  if (info.lead) return 0.7;
  if (/Valued images/i.test(cats)) return 0.6;
  return 0;
}
const SOURCE_PRIOR = { manual: 1, wikidata: 0.9, osm_tag: 0.85, wikipedia: 0.85, commons_category: 0.7, commons_geo: 0.5 };

/**
 * One candidate photo for one POI. `evidence` says why it may show the POI:
 * manual | p18 | lead | osm_file | category (member of the linked Commons category) | geo.
 */
/** Feature words: a title about another kind of place ("An Bàng Bridge" for a beach) is not evidence. */
const FEATURES = {
  beach: /\b(beach|bai bien|bai tam)\b/,
  bridge: /\b(bridge)\b/,
  market: /\b(market|cho dem)\b/,
  temple: /\b(pagoda|temple|shrine)\b/,
  church: /\b(church|cathedral|nha tho)\b/,
  museum: /\b(museum|bao tang)\b/,
  lodging: /\b(resort|hotel|khach san|villa|homestay)\b/,
  park: /\b(park|cong vien)\b/,
};
const FEATURE_OF = {
  beach: 'beach', bridge: 'bridge', market: 'market', pagoda: 'temple', temple: 'temple', church: 'church',
  museum: 'museum', gallery: 'museum', park: 'park', theme_park: 'park', water_park: 'park', hotel: 'lodging', resort: 'lodging',
};
export function otherFeature(category, text) {
  const own = FEATURE_OF[category];
  if (!own) return false;
  const folded = fold(text);
  if (FEATURES[own].test(folded)) return false;
  return Object.entries(FEATURES).some(([family, re]) => family !== own && re.test(folded));
}
export function scoreCandidate(poi, info, evidence, { link } = {}) {
  const linkScore = link?.score ?? 0;
  const names = poiNames(poi);
  const titleText = `${info.title} ${info.description ?? ''}`;
  const mentioned = mentionsName(`${titleText} ${(info.categories ?? []).join(' ')}`, names);
  // A distance-matched photo must not be about another kind of place nearby.
  const named = mentioned && !(evidence.kind === 'geo' && otherFeature(poi.category, titleText));
  let match = 0, source = 'commons_geo';
  switch (evidence.kind) {
    case 'manual': match = 1; source = 'manual'; break;
    case 'p18': match = 0.95 * linkScore; source = 'wikidata'; break;
    case 'lead': match = 0.9 * linkScore; source = 'wikipedia'; break;
    case 'osm_file': match = 0.95; source = 'osm_tag'; break;
    case 'category': match = Math.min(1, 0.75 * linkScore + (named ? 0.15 : 0)); source = 'commons_category'; break;
    case 'geo': {
      const radius = matchRadius(poi.category);
      const proximity = Math.max(0, 1 - (evidence.distance ?? radius) / radius);
      match = named ? Math.min(0.9, 0.55 + 0.25 * proximity + 0.1) : evidence.distance <= 30 ? 0.4 : 0;
      break;
    }
  }
  const quality = qualityScore(info, { hero: true }) || qualityScore(info, { hero: false }) * 0.7;
  const semantic = evidence.kind === 'manual' ? 1 : semanticScore(info);
  const prominence = prominenceScore({ ...info, p18: evidence.kind === 'p18', lead: evidence.kind === 'lead' });
  const penalties = showsPeople(`${info.title} ${(info.categories ?? []).join(' | ')}`) ? 0.1 : 0;
  const final = 0.35 * match + 0.25 * quality + 0.2 * semantic + 0.1 * prominence + 0.1 * (SOURCE_PRIOR[source] ?? 0.5) - penalties;
  const round = (n) => Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
  return {
    source, named,
    match: round(match), quality: round(quality), semantic: round(semantic), final: round(final),
    // A photo matched by distance alone never becomes the hero (strategy §5 P3).
    heroEligible: evidence.kind !== 'geo' || named,
    galleryEligible: evidence.kind !== 'geo' || named || (evidence.distance <= 30 && isTourism(poi.category)),
  };
}
const TOURISM = /^(museum|gallery|beach|bridge|pagoda|temple|church|market|park|theme_park|water_park|amusement_park|viewpoint|attraction|monument|historic|landmark|island|mountain|waterfall|cave|zoo|garden|nature|old_town|old_quarter|craft_village|performance_venue|playground|walking_street|campground|trailhead)/;
export function isTourism(category) {
  return TOURISM.test(String(category ?? ''));
}

/**
 * Category codes of the search groups in `spec` ("tourism,accommodation"); "all" = no filter (null).
 * `groups` is POI_SEARCH_CATEGORIES (packages/common): the same groups as the Places API, fed by
 * the Overture → Wolfari mapping in scripts/poi/overture-taxonomy.mjs.
 */
export function groupCategories(spec, groups) {
  const names = String(spec ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (names.includes('all')) return null;
  const unknown = names.filter((name) => !Object.hasOwn(groups, name));
  if (!names.length || unknown.length)
    throw new Error(`--groups: nhóm không hợp lệ "${unknown.join(',') || spec}"; dùng ${Object.keys(groups).join(', ')} hoặc all.`);
  return [...new Set(names.flatMap((name) => groups[name]))];
}

export const HERO_THRESHOLD = 0.6;
export const GALLERY_THRESHOLD = 0.5;
export const GALLERY_SIZE = 7;
/**
 * Hero = best eligible candidate above HERO_THRESHOLD with hero-grade pixels; gallery = up to 7 more,
 * deduplicated by content hash and at most 2 per author for variety.
 */
export function selectPhotos(candidates) {
  const unique = [];
  const seen = new Set();
  for (const c of [...candidates].sort((a, b) => b.score.final - a.score.final || a.info.title.localeCompare(b.info.title))) {
    const key = c.info.sha1 ?? c.info.title;
    if (seen.has(key) || !c.license) continue;
    seen.add(key);
    unique.push(c);
  }
  // A hero must look like a view of the place: no species close-up, crowd or portrait.
  const hero = unique.find((c) => c.score.heroEligible && c.score.final >= HERO_THRESHOLD && qualityScore(c.info, { hero: true }) > 0 && c.score.semantic >= 0.4);
  const authors = new Map();
  const gallery = [];
  for (const c of unique) {
    if (c === hero || gallery.length >= GALLERY_SIZE) continue;
    if (!c.score.galleryEligible || c.score.final < GALLERY_THRESHOLD || c.score.semantic === 0 || qualityScore(c.info, { hero: false }) === 0) continue;
    const author = fold(c.info.author ?? '');
    if ((authors.get(author) ?? 0) >= 2) continue;
    authors.set(author, (authors.get(author) ?? 0) + 1);
    gallery.push(c);
  }
  return { hero, gallery: hero ? gallery : [] };
}

/** Cells (≈ size°) that contain at least one POI, as geosearch centres. */
export function cellsFor(points, size = 0.05) {
  const cells = new Map();
  for (const p of points) {
    const x = Math.floor(p.longitude / size), y = Math.floor(p.latitude / size);
    cells.set(`${x}:${y}`, { minLon: x * size, minLat: y * size, maxLon: (x + 1) * size, maxLat: (y + 1) * size });
  }
  return [...cells.values()];
}
/** Split a cell in four (geosearch returned its 500-row ceiling). */
export function splitCell(cell) {
  const midLon = (cell.minLon + cell.maxLon) / 2, midLat = (cell.minLat + cell.maxLat) / 2;
  return [
    { minLon: cell.minLon, minLat: cell.minLat, maxLon: midLon, maxLat: midLat },
    { minLon: midLon, minLat: cell.minLat, maxLon: cell.maxLon, maxLat: midLat },
    { minLon: cell.minLon, minLat: midLat, maxLon: midLon, maxLat: cell.maxLat },
    { minLon: midLon, minLat: midLat, maxLon: cell.maxLon, maxLat: cell.maxLat },
  ];
}
/** Centre and covering radius (m) of a cell, capped at the geosearch maximum of 10 km. */
export function cellCircle(cell) {
  const lat = (cell.minLat + cell.maxLat) / 2, lon = (cell.minLon + cell.maxLon) / 2;
  const radius = Math.ceil(distanceMeters(lat, lon, cell.maxLat, cell.maxLon));
  return { latitude: lat, longitude: lon, radius: Math.min(10_000, Math.max(10, radius)) };
}
/**
 * POIs whose surroundings are geosearched: golden POIs and sights. Geosearch is the slowest call
 * (8 s apart) and hotels, shops or restaurants rarely have a named, geotagged Commons photo; they
 * still get the files found in a searched cell nearby.
 */
export function geoSearchPoints(pois) {
  return pois.filter((poi) => !poi.coord_pileup && (poi.kind === 'golden' || isTourism(poi.category)));
}

/** "Ảnh: <author> · <licence> · Wikimedia Commons" — the line shown next to every photo. */
export function attributionLine(author, license, source = 'Wikimedia Commons') {
  return [author ? `Ảnh: ${author}` : 'Ảnh', license?.label, source].filter(Boolean).join(' · ');
}
