import { describe, expect, it } from 'vitest';
import { POI_SEARCH_CATEGORIES } from '../packages/common/src/poi-taxonomy';
import {
  attributionLine, cellCircle, cellsFor, exactNameRadius, geoSearchPoints, groupCategories, linkEntities, matchRadius,
  mentionsName, nameScore, normalizeLicense, normalizeAuthor, otherFeature, plainText, qualityScore, sameName, scoreCandidate,
  selectPhotos, semanticScore, splitCell, typeCompatible,
} from './poi/images/lib.mjs';
import { SQL, mergeManifest, photosToStore, replacedKeys, writeBatch } from './poi/images/batch.mjs';

const dragon = {
  key: 'dn-cau-rong', kind: 'golden', name_vi: 'Cầu Rồng', name_en: 'Dragon Bridge', aliases: ['Dragon Bridge Da Nang'],
  category: 'bridge', latitude: 16.0612, longitude: 108.2274, coord_pileup: false,
};
const item = (over: Record<string, unknown>) => ({
  qid: 'Q1', latitude: 16.0613, longitude: 108.2275, label_vi: 'Cầu Rồng', label_en: 'Dragon Bridge', aliases: [], p31: ['Q12280'], ...over,
});
const photo = (over: Record<string, unknown> = {}) => ({
  title: 'File:Cau Rong Da Nang.jpg', width: 4000, height: 2600, mime: 'image/jpeg', sha1: 'a', author: 'An', categories: ['Dragon Bridge'], description: '', ...over,
});

describe('POI images: linking POIs to Wikidata', () => {
  it('uses a wide radius for areas and a tight one for points', () => {
    expect(matchRadius('beach')).toBe(1500);
    expect(matchRadius('nature_area')).toBe(1500);
    expect(matchRadius('museum')).toBe(150);
  });
  it('requires a real name match, not a generic word', () => {
    expect(nameScore(dragon, ['Dragon Bridge'])).toBe(1);
    expect(nameScore(dragon, ['Cầu Sông Hàn'])).toBeLessThan(0.6);
    expect(mentionsName('File:Cầu Rồng về đêm.jpg', ['cau rong'])).toBe(true);
    // "Cầu" alone is generic and never counts as evidence.
    expect(mentionsName('File:Cau.jpg', ['cau'])).toBe(false);
  });
  it('rules out a known type clash and stays neutral for unknown types', () => {
    expect(typeCompatible('bridge', ['Q12280'])).toBe(true);
    expect(typeCompatible('museum', ['Q27686'])).toBe(false); // hotel item for a museum POI
    expect(typeCompatible('bridge', ['Q999999'])).toBe(true);
  });
  it('links one-to-one, trusts OSM tags and drops ambiguous or far candidates', () => {
    const near = item({ qid: 'Q10' });
    const far = item({ qid: 'Q11', latitude: 16.07 }); // ~1 km away: outside a point radius
    expect(linkEntities([dragon], [near, far]).map((l) => l.qid)).toEqual(['Q10']);
    // Two equally good candidates → ambiguous → no link.
    expect(linkEntities([dragon], [near, item({ qid: 'Q12' })])).toEqual([]);
    // OSM wikidata tag wins even without coordinates in our pull.
    expect(linkEntities([dragon], [], { osmWikidata: new Map([['dn-cau-rong', 'Q42']]) })[0]).toMatchObject({ qid: 'Q42', method: 'osm_tag', score: 1 });
    // One item cannot serve two POIs.
    const twin = { ...dragon, key: 'dn-twin', latitude: 16.0619 };
    expect(linkEntities([dragon, twin], [near])).toHaveLength(1);
  });
  it('links pile-up (centroid) POIs only by an exact, unique name', () => {
    const pile = { ...dragon, coord_pileup: true, latitude: 16.3, longitude: 108.4 }; // ~32 km off
    expect(linkEntities([pile], [item({ qid: 'Q10' })])[0]).toMatchObject({ method: 'exact_name' });
    expect(linkEntities([pile], [item({ qid: 'Q10' }), item({ qid: 'Q13' })])).toEqual([]);
  });
});

describe('POI images: licences and scoring', () => {
  it('keeps only CC0, public domain, CC BY and CC BY-SA', () => {
    expect(normalizeLicense({ License: 'cc-by-sa-4.0' })).toEqual({ code: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0' });
    expect(normalizeLicense({ License: 'cc-by-3.0' })).toEqual({ code: 'CC-BY-3.0', label: 'CC BY 3.0' });
    expect(normalizeLicense({ License: 'cc0' })?.code).toBe('CC0-1.0');
    expect(normalizeLicense({ License: 'pd', LicenseShortName: 'Public domain' })?.code).toBe('PD');
    expect(normalizeLicense({ License: 'cc-by-nc-sa-2.0' })).toBeNull();
    expect(normalizeLicense({ License: 'cc-by-nd-4.0' })).toBeNull();
    expect(normalizeLicense({ License: 'gfdl' })).toBeNull();
    expect(normalizeLicense({})).toBeNull();
  });
  it('reads attribution HTML as text', () => {
    expect(plainText('<a href="x">Nguyễn&nbsp;An</a> &amp; Bình')).toBe('Nguyễn An & Bình');
    expect(attributionLine('An', { label: 'CC BY-SA 4.0' })).toBe('Ảnh: An · CC BY-SA 4.0 · Wikimedia Commons');
  });
  it('judges pixels and content from metadata', () => {
    expect(qualityScore(photo(), { hero: true })).toBeGreaterThan(0.8);
    expect(qualityScore(photo({ width: 700, height: 500 }), { hero: true })).toBe(0); // too small for a hero
    expect(qualityScore(photo({ width: 4000, height: 1000 }), { hero: true })).toBe(0); // panorama strip
    expect(qualityScore(photo({ mime: 'image/svg+xml' }), { hero: false })).toBe(0);
    expect(semanticScore(photo({ title: 'File:Ban do Da Nang.jpg' }))).toBe(0);
    expect(semanticScore(photo({ title: 'File:Logo Sun World.png' }))).toBe(0);
    expect(semanticScore(photo({ title: 'File:Cau Rong toan canh.jpg' }))).toBe(0.8);
  });
  it('never makes a distance-only photo the hero', () => {
    const geoNamed = scoreCandidate(dragon, photo(), { kind: 'geo', distance: 40 });
    const geoBlind = scoreCandidate(dragon, photo({ title: 'File:IMG 2041.jpg', categories: [] }), { kind: 'geo', distance: 20 });
    expect(geoNamed.heroEligible).toBe(true);
    expect(geoBlind.heroEligible).toBe(false);
    expect(geoBlind.galleryEligible).toBe(true); // ≤ 30 m from a sight: gallery only
    expect(scoreCandidate(dragon, photo({ title: 'File:IMG 2041.jpg', categories: [] }), { kind: 'geo', distance: 120 }).galleryEligible).toBe(false);
    const p18 = scoreCandidate(dragon, photo(), { kind: 'p18' }, { link: { score: 1 } });
    expect(p18.final).toBeGreaterThan(geoNamed.final);
  });
  it('picks a hero above the threshold and a varied, deduplicated gallery', () => {
    const license = { code: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0' };
    const make = (title: string, kind: string, over: Record<string, unknown> = {}) => {
      const info = photo({ title, sha1: title, ...over });
      return { info, license, evidence: { kind, distance: 10 }, score: scoreCandidate(dragon, info, { kind, distance: 10 }, { link: { score: 1 } }) };
    };
    const { hero, gallery } = selectPhotos([
      make('File:Cau Rong 1.jpg', 'p18'),
      make('File:Cau Rong 2.jpg', 'category'),
      make('File:Cau Rong 2 copy.jpg', 'category', { sha1: 'File:Cau Rong 2.jpg' }), // same bytes
      make('File:Cau Rong 3.jpg', 'category'),
      make('File:Cau Rong 4.jpg', 'category'),
      make('File:Ban do cau rong.jpg', 'category'),
    ]);
    expect(hero?.info.title).toBe('File:Cau Rong 1.jpg');
    // Same bytes kept once, ≤ 2 photos per author, never the map.
    expect(gallery).toHaveLength(2);
    expect(new Set(gallery.map((g) => g.info.sha1)).size).toBe(2);
    expect(gallery.some((g) => g.info.title.includes('Ban do'))).toBe(false);
    expect(selectPhotos([make('File:x.jpg', 'geo', { title: 'File:IMG.jpg', categories: [] })]).hero).toBeUndefined();
  });
  it('splits geosearch cells and keeps circles within the 10 km limit', () => {
    const [cell] = cellsFor([{ latitude: 16.06, longitude: 108.22 }], 0.05);
    expect(splitCell(cell)).toHaveLength(4);
    const circle = cellCircle(cell);
    expect(circle.radius).toBeGreaterThan(3000);
    expect(circle.radius).toBeLessThanOrEqual(10_000);
  });
});

describe('POI images: pilot precision fixes', () => {
  const beach = { ...dragon, key: 'dn-an-bang', name_vi: 'Bãi biển An Bàng', name_en: 'An Bang Beach', aliases: ['An Bàng'], category: 'beach' };
  it('rejects a nearby photo about another kind of place', () => {
    expect(otherFeature('beach', 'View from the An Bàng Bridge 2')).toBe(true);
    expect(otherFeature('beach', 'Resort development at Non Nuoc')).toBe(true);
    expect(otherFeature('beach', 'An Bang beach at sunset')).toBe(false);
    expect(otherFeature('craft_village', 'Bridge')).toBe(false); // no family: no check
    const s = scoreCandidate(beach, photo({ title: 'File:View from the An Bàng Bridge 2.jpg', categories: [] }), { kind: 'geo', distance: 300 });
    expect(s.named).toBe(false);
    expect(s.heroEligible).toBe(false);
  });
  it('never makes a species close-up the hero', () => {
    const monkey = photo({ title: 'File:Rhesus macaque (Macaca mulatta) hybrid Son Tra.jpg' });
    expect(semanticScore(monkey)).toBe(0.2);
    expect(semanticScore(photo({ title: 'File:Hoi An khi ve dem.jpg' }))).toBe(0.5); // "khi" = "when"
    const license = { code: 'CC0-1.0', label: 'CC0' };
    const sonTra = { ...dragon, name_vi: 'Bán đảo Sơn Trà', name_en: 'Son Tra Peninsula', aliases: ['Son Tra'], category: 'nature_area' };
    const c = { info: monkey, license, evidence: { kind: 'geo', distance: 100 }, score: scoreCandidate(sonTra, monkey, { kind: 'geo', distance: 100 }) };
    expect(selectPhotos([c]).hero).toBeUndefined();
  });
});

describe('POI images: credits', () => {
  it('drops unknown authors and repeated names', () => {
    expect(normalizeAuthor('Unknown author Unknown author')).toBeUndefined();
    expect(normalizeAuthor('<span>Unknown author</span>')).toBeUndefined();
    expect(normalizeAuthor('Vivu Vietnam')).toBe('Vivu Vietnam');
    expect(normalizeAuthor('An An')).toBe('An');
    expect(normalizeAuthor('')).toBeUndefined();
  });
});

describe('POI images: Vietnamese words are not English tokens', () => {
  const view = (title: string, over: Record<string, unknown> = {}) => semanticScore(photo({ title, categories: [], ...over }));
  it('keeps Mỹ Sơn photos and still spots "my son" family photos', () => {
    expect(view('File:2024 - Mỹ Sơn Sanctuary Temple E7 - img 01.jpg', { categories: ['My Son E7', 'Quality images'] })).toBe(0.5);
    expect(view('File:My Son Sanctuary Vietnam 03.jpg')).toBe(0.5);
    expect(view('File:Ruins.jpg', { description: 'Temples at my son sanctuary' })).toBe(0.5);
    expect(view('File:My son at the beach.jpg')).toBe(0.3);
    expect(view('File:Walking with my wife in Hoi An.jpg')).toBe(0.3);
    // The pilot's Mỹ Sơn P18 is a hero again (it lost every Mỹ Sơn photo to the "my son" rule).
    const mySon = { ...dragon, key: 'dn-my-son', name_vi: 'Khu đền tháp Mỹ Sơn', name_en: 'My Son Sanctuary', aliases: ['My Son'], category: 'historic' };
    const info = photo({ title: 'File:2024 - Mỹ Sơn Sanctuary Temple E7 - img 01.jpg', width: 4032, height: 3024, categories: ['My Son E7'] });
    const p18 = { info, license: { code: 'CC-BY-4.0', label: 'CC BY 4.0' }, evidence: { kind: 'p18' }, score: scoreCandidate(mySon, info, { kind: 'p18' }, { link: { score: 1 } }) };
    expect(selectPhotos([p18]).hero?.info.title).toBe(info.title);
  });
  it('tells cờ (flag) from cổ, có, Bàn Cờ and Lăng Cô', () => {
    expect(view('File:Toàn cảnh Đà Nẵng từ đỉnh bàn cờ bán đảo Sơn Trà.png')).toBe(0.8);
    expect(view('File:Phố cổ Hội An về đêm.jpg')).toBe(0.5);
    expect(view('File:Nhà cổ Tấn Ký.jpg')).toBe(0.5);
    expect(view('File:Da Nang Lang Co Deo Hai Van (11097).jpg')).toBe(0.5);
    expect(view('File:Lá cờ Việt Nam.jpg')).toBe(0);
    expect(view('File:Flag of Vietnam.png')).toBe(0);
    expect(view('File:Flag Tower of Hanoi.jpg')).toBe(0.5); // Cột cờ Hà Nội is a sight
  });
  it('tells tiền (money) from Tiên, tem (stamp) from têm, and keeps signs and maps out', () => {
    expect(view('File:Ban dao Son Tra.jpg', { description: 'Son Tra Peninsular. The Tien Sa Terminal of Danang Port.' })).toBe(0.5);
    expect(view('File:Suối Tiên.jpg')).toBe(0.5);
    expect(view('File:Tờ tiền 500.000 đồng.jpg')).toBe(0);
    expect(view('File:Inspiration for the 100 Piastre banknote in Hoi An.jpg')).toBe(0);
    expect(view('File:Tem Việt Nam 1990.jpg')).toBe(0);
    expect(view('File:Stamp of Vietnam - Cau Rong.jpg')).toBe(0);
    expect(view('File:Trầu têm cánh phượng.jpg')).not.toBe(0);
    expect(view('File:Cho Con DN sign.JPG')).toBe(0);
    expect(view('File:P.115 Hai Bà Trưng.jpg', { categories: ['Road sign 115 (Vietnam)'] })).toBe(0);
    expect(view('File:Bản đồ Đà Nẵng.png')).toBe(0);
    expect(view('File:Ban do Da Nang.jpg')).toBe(0);
  });
  it('does not read history in a description as a building site', () => {
    expect(view('File:Chùa Linh Ứng.jpg', { description: 'Chùa được xây dựng năm 2004' })).toBe(0.5);
    expect(view('File:Hoi An.jpg', { description: 'Construction of the bridge began in 1593' })).toBe(0.5);
    expect(view('File:Resort development at Non Nuoc.jpg')).toBe(0);
    expect(view('File:Thuan Phuoc bridge under construction.jpg')).toBe(0);
    expect(view('File:Construction in Han River DN.jpg')).toBe(0);
    expect(view('File:508 Ong Ich Khiem.jpg', { categories: ['Images with watermarks'] })).toBe(0);
  });
  it('does not take names for people or species', () => {
    expect(view("File:Da Nang People's Committee building in 2015 01.jpg")).toBe(0.5);
    expect(view('File:People sitting on the beach.jpg')).toBe(0.3);
    // Caught before only because "Tien" folded to "tiền" (money).
    expect(view('File:Mr. Nguyen Xuan Tien Speaks at the Danang Stakeholder Meeting.jpg')).toBe(0.3);
    expect(view('File:Hai Chau communal meeting house.jpg')).toBe(0.5); // đình
    expect(view('File:ChùaCầu.jpg', { description: 'Hình thuộc bản quyền người truyền lên.' })).toBe(0.5);
    expect(view('File:Gia Dinh Park.jpg')).toBe(0.5); // Gia Định, not gia đình (family)
    expect(view('File:Gia đình ở biển Mỹ Khê.jpg')).toBe(0.3);
    expect(view('File:Monkey Mountain view.jpg')).toBe(0.8); // Sơn Trà alias
    expect(view('File:Thuyền buồm trên vịnh Hạ Long.jpg')).toBe(0.5); // buồm = sail, bướm = butterfly
    expect(view('File:Bướm vàng.jpg')).toBe(0.2);
  });
});

describe('POI images: radius by kind of place', () => {
  const pass = {
    key: 'dn-deo-hai-van', kind: 'golden', name_vi: 'Đèo Hải Vân', name_en: 'Hai Van Pass', aliases: ['Hải Vân Quan'],
    category: 'viewpoint', latitude: 16.169143, longitude: 108.126262, coord_pileup: false,
  };
  // Pilot data: the Wikidata point of the pass and of its gate are ~2.1 km from the golden pin.
  const haiVan = { qid: 'Q1477078', latitude: 16.1875, longitude: 108.13083333, label_vi: 'Đèo Hải Vân', label_en: 'Hai Van Pass', aliases: ['Hải Vân', 'Col des Nuages'], p31: ['Q133056'] };
  const gate = { qid: 'Q131186991', latitude: 16.1877529, longitude: 108.13128496, label_vi: 'Hải Vân quan', label_en: 'Hai Van Gate', aliases: [], p31: [] };
  it('gives viewpoints an area radius and large features a far radius for exact names only', () => {
    expect(matchRadius('viewpoint')).toBe(1500);
    expect(exactNameRadius('viewpoint')).toBe(5000);
    expect(exactNameRadius('nature_area')).toBe(5000);
    expect(exactNameRadius('beach')).toBe(3000);
    expect(exactNameRadius('museum')).toBe(150); // points: no extension
    expect(sameName(pass, ['Hải Vân quan'])).toBe(true);
    expect(sameName(pass, ['Hải Vân quan'], { primary: true })).toBe(false);
  });
  it('links Đèo Hải Vân 2.1 km away by its exact name, preferring its own name over an alias', () => {
    const [link] = linkEntities([pass], [haiVan, gate]);
    expect(link).toMatchObject({ qid: 'Q1477078', method: 'exact_name_far' });
    expect(link.score).toBeGreaterThan(0.6);
    expect(link.score).toBeLessThan(0.7); // always below a near match
  });
  it('keeps precision: no far link by a similar name, for a point, or against a near match', () => {
    const similar = { ...haiVan, qid: 'Q9', label_vi: 'Hầm Hải Vân', label_en: 'Hai Van Tunnel', aliases: [] };
    expect(linkEntities([pass], [similar])).toEqual([]);
    const museum = { ...dragon, name_vi: 'Bảo tàng Đà Nẵng', name_en: 'Da Nang Museum', aliases: [], category: 'museum' };
    expect(linkEntities([museum], [item({ qid: 'Q20', latitude: 16.0648, label_vi: 'Bảo tàng Đà Nẵng', label_en: 'Da Nang Museum', p31: ['Q33506'] })])).toEqual([]); // 400 m
    const near = { ...haiVan, qid: 'Q30', latitude: 16.1695, longitude: 108.1265 };
    expect(linkEntities([pass], [haiVan, near])[0]).toMatchObject({ qid: 'Q30', method: 'geo_name' });
    // Two equally named far items stay ambiguous.
    expect(linkEntities([pass], [haiVan, { ...haiVan, qid: 'Q31' }])).toEqual([]);
  });
});

describe('POI images: which POIs a run covers', () => {
  it('maps --groups to taxonomy codes (default tourism skips ATMs, shops and services)', () => {
    const tourism = groupCategories('tourism', POI_SEARCH_CATEGORIES);
    expect(tourism).toContain('museum');
    expect(tourism).toContain('viewpoint');
    expect(tourism).not.toContain('traveler_service'); // ATM, pharmacy…
    expect(tourism).not.toContain('shopping');
    expect(tourism).not.toContain('accommodation');
    expect(groupCategories('tourism, accommodation', POI_SEARCH_CATEGORIES)).toContain('accommodation');
    expect(groupCategories('all', POI_SEARCH_CATEGORIES)).toBeNull();
    expect(() => groupCategories('tourism,hotels', POI_SEARCH_CATEGORIES)).toThrow(/hotels/);
    expect(() => groupCategories('', POI_SEARCH_CATEGORIES)).toThrow(/--groups/);
  });
  it('geosearches only around golden POIs and sights', () => {
    const at = (over: Record<string, unknown>) => ({ ...dragon, kind: 'overture', coord_pileup: false, ...over });
    const kept = geoSearchPoints([
      at({ key: 'g', kind: 'golden', category: 'restaurant' }),
      at({ key: 'm', category: 'museum' }),
      at({ key: 'w', category: 'walking_street' }),
      at({ key: 'h', category: 'accommodation' }),
      at({ key: 'a', category: 'traveler_service' }),
      at({ key: 'p', category: 'museum', coord_pileup: true }),
    ]);
    expect(kept.map((p: { key: string }) => p.key)).toEqual(['g', 'm', 'w']);
  });
});

/** In-memory stand-in for the statements writeBatch sends (same keys and uniqueness as V006). */
function memoryDb() {
  type Row = Record<string, unknown> & { batch_id: string };
  const db = { batches: new Map<string, { manifest: unknown; is_active: boolean }>(), media: [] as Row[], links: [] as Row[], log: [] as string[] };
  const key = (r: Record<string, unknown>) => (r.golden_key ?? r.gers_id) as string;
  const owned = (r: Row, [batch, golden, gers]: unknown[]) =>
    r.batch_id === batch && ((golden as string[]).includes(r.golden_key as string) || (gers as string[]).includes(r.gers_id as string));
  const client = {
    async query(text: string, values: unknown[] = []) {
      db.log.push(text);
      const [id] = values as string[];
      switch (text) {
        case 'BEGIN': case 'COMMIT': case 'ROLLBACK': return { rowCount: 0, rows: [] };
        case SQL.exists: return { rowCount: db.batches.has(id) ? 1 : 0, rows: [] };
        case SQL.dropBatch:
          db.batches.delete(id);
          db.media = db.media.filter((r) => r.batch_id !== id);
          db.links = db.links.filter((r) => r.batch_id !== id);
          return { rowCount: 1, rows: [] };
        case SQL.createBatch:
          if (db.batches.has(id)) throw new Error('duplicate key');
          db.batches.set(id, { manifest: values[1], is_active: false });
          return { rowCount: 1, rows: [] };
        case SQL.ensureBatch:
          if (!db.batches.has(id)) db.batches.set(id, { manifest: values[1], is_active: false });
          return { rowCount: 1, rows: [] };
        case SQL.lockBatch: return { rowCount: 1, rows: [{ manifest: db.batches.get(id)?.manifest }] };
        case SQL.deleteMedia: db.media = db.media.filter((r) => !owned(r, values) || r.status === 'takedown'); return { rowCount: 0, rows: [] };
        case SQL.deleteLinks: db.links = db.links.filter((r) => !owned(r, values)); return { rowCount: 0, rows: [] };
        case SQL.insertMedia:
          for (const r of JSON.parse(values[0] as string)) {
            const dup = db.media.some((m) => m.batch_id === values[1] && key(m) === key(r) && (m.sha256 === r.sha256 || (m.role === 'hero' && r.role === 'hero' && m.status === 'accepted')));
            if (!dup) db.media.push({ ...r, status: 'accepted', batch_id: values[1] as string });
          }
          return { rowCount: 0, rows: [] };
        case SQL.insertLinks:
          for (const r of JSON.parse(values[0] as string)) db.links.push({ ...r, batch_id: values[1] as string });
          return { rowCount: 0, rows: [] };
        case SQL.totals: {
          const rows = db.media.filter((r) => r.batch_id === id && r.status === 'accepted');
          return { rows: [{ heroes: String(rows.filter((r) => r.role === 'hero').length), gallery: String(rows.filter((r) => r.role === 'gallery').length), files: String(new Set(rows.map((r) => r.sha256)).size) }] };
        }
        case SQL.setManifest: db.batches.get(id)!.manifest = values[1]; return { rowCount: 1, rows: [] };
        case SQL.deactivateOthers: for (const [k, b] of db.batches) if (k !== id) b.is_active = false; return { rowCount: 0, rows: [] };
        case SQL.activate: db.batches.get(id)!.is_active = true; return { rowCount: 1, rows: [] };
        default: throw new Error(`unexpected SQL: ${text.slice(0, 40)}`);
      }
    },
  };
  return { db, client };
}

describe('POI images: cumulative batches (--into) and --hero-only', () => {
  const hero = (title: string) => ({ title });
  const sel = (key: string, kind: string, heroTitle?: string, gallery: string[] = []) => ({ key, kind, hero: heroTitle ? hero(heroTitle) : undefined, gallery: gallery.map(hero) });
  const media = (key: string, kind: string, role: string, sha256: string) => ({ gers_id: kind === 'overture' ? key : null, golden_key: kind === 'golden' ? key : null, role, sha256 });
  const link = (key: string, kind: string) => ({ gers_id: kind === 'overture' ? key : null, golden_key: kind === 'golden' ? key : null, scheme: 'wikidata', value: `Q-${key}` });
  const base = { created_by: 'test', thresholds: { hero: 0.6, gallery: 0.5 } };
  const runInto = (client: object, run: string, selection: ReturnType<typeof sel>[], rows: object[], failed = new Set<string>()) =>
    writeBatch(client, {
      batch: 'img-vn1', mode: 'merge', rows, links: selection.map((s) => link(s.key, s.kind)), keys: replacedKeys(selection, failed),
      manifest: { ...base, run: { run, pois: selection.length } },
    });
  it('downloads only heroes with --hero-only', () => {
    const selection = [sel('a', 'golden', 'File:A.jpg', ['File:A2.jpg', 'File:A3.jpg']), sel('b', 'overture', undefined, [])];
    expect(photosToStore(selection).map((p: { role: string }) => p.role)).toEqual(['hero', 'gallery', 'gallery']);
    expect(photosToStore(selection, { heroOnly: true }).map((p: { photo: { title: string } }) => p.photo.title)).toEqual(['File:A.jpg']);
  });
  it('splits replaced keys by kind and keeps POIs whose hero failed to download', () => {
    const selection = [sel('dn-a', 'golden', 'File:A.jpg'), sel('gers-b', 'overture', 'File:B.jpg'), sel('gers-c', 'overture')];
    expect(replacedKeys(selection, new Set(['gers-b']))).toEqual({ golden: ['dn-a'], gers: ['gers-c'] });
  });
  it('adds provinces to one batch, replaces only the run\'s own POIs and is idempotent', async () => {
    const { db, client } = memoryDb();
    const p48 = [sel('dn-a', 'golden', 'File:A.jpg'), sel('gers-b', 'overture', 'File:B.jpg')];
    const p48rows = [media('dn-a', 'golden', 'hero', 'a1'), media('dn-a', 'golden', 'gallery', 'a2'), media('gers-b', 'overture', 'hero', 'b1')];
    await runInto(client, 'img-vn1-48', p48, p48rows);
    const p01 = [sel('gers-c', 'overture', 'File:C.jpg')];
    await runInto(client, 'img-vn1-01', p01, [media('gers-c', 'overture', 'hero', 'c1')]);
    expect(db.media.map((r) => r.sha256).sort()).toEqual(['a1', 'a2', 'b1', 'c1']);
    expect(db.log).not.toContain(SQL.dropBatch);
    // Rerun of province 48 with a new hero for dn-a: dn-a's rows replaced, gers-c untouched.
    const rerun = [media('dn-a', 'golden', 'hero', 'a9'), media('gers-b', 'overture', 'hero', 'b1')];
    const { manifest } = await runInto(client, 'img-vn1-48', p48, rerun);
    const state = () => db.media.map((r) => `${r.golden_key ?? r.gers_id}:${r.role}:${r.sha256}`).sort();
    expect(state()).toEqual(['dn-a:hero:a9', 'gers-b:hero:b1', 'gers-c:hero:c1']);
    expect(manifest).toMatchObject({ cumulative: true, pois: 3, heroes: 3, gallery: 0, files: 3 });
    expect(manifest.runs.map((r: { run: string }) => r.run)).toEqual(['img-vn1-01', 'img-vn1-48']);
    expect(db.links).toHaveLength(3);
    // Same run again: same rows, same manifest entries.
    await runInto(client, 'img-vn1-48', p48, rerun);
    expect(state()).toEqual(['dn-a:hero:a9', 'gers-b:hero:b1', 'gers-c:hero:c1']);
    expect((db.batches.get('img-vn1')!.manifest as { runs: unknown[] }).runs).toHaveLength(2);
    expect(db.links).toHaveLength(3);
  });
  it('keeps a POI\'s previous photos when its new hero failed to download', async () => {
    const { db, client } = memoryDb();
    const run = [sel('gers-b', 'overture', 'File:B.jpg', ['File:B2.jpg'])];
    await runInto(client, 'r1', run, [media('gers-b', 'overture', 'hero', 'b1')]);
    // New hero failed, its gallery photo was stored: nothing of this POI changes.
    await runInto(client, 'r2', run, [media('gers-b', 'overture', 'gallery', 'b7')], new Set(['gers-b']));
    expect(db.media.map((r) => `${r.role}:${r.sha256}`)).toEqual(['hero:b1']);
  });
  it('never brings back a taken-down photo', async () => {
    const { db, client } = memoryDb();
    const run = [sel('gers-b', 'overture', 'File:B.jpg')];
    await runInto(client, 'r1', run, [media('gers-b', 'overture', 'hero', 'b1')]);
    db.media[0].status = 'takedown';
    // The same photo is chosen again: the takedown row stays and blocks it; another photo may be the hero.
    const { manifest } = await runInto(client, 'r1', run, [media('gers-b', 'overture', 'hero', 'b1')]);
    expect(db.media.map((r) => `${r.sha256}:${r.status}`)).toEqual(['b1:takedown']);
    expect(manifest.heroes).toBe(0);
    await runInto(client, 'r1', run, [media('gers-b', 'overture', 'hero', 'b2')]);
    expect(db.media.map((r) => `${r.sha256}:${r.status}`)).toEqual(['b1:takedown', 'b2:accepted']);
  });
  it('turns a batch loaded without --into into the first run entry', () => {
    const merged = mergeManifest({ pois: 49, heroes: 28, gallery: 142 }, { ...base, run: { run: 'img-dn-2', pois: 10 } }, { heroes: '30', gallery: '142', files: '170' }, 'img-pilot-dn1');
    expect(merged.runs).toEqual([{ run: 'img-pilot-dn1', pois: 49, heroes: 28, gallery: 142 }, { run: 'img-dn-2', pois: 10 }]);
    expect(merged).toMatchObject({ pois: 59, heroes: 30, gallery: 142, files: 170, cumulative: true });
    expect(merged).not.toHaveProperty('run');
  });
  it('keeps create/replace semantics and rolls back on error', async () => {
    const { db, client } = memoryDb();
    const rows = [media('dn-a', 'golden', 'hero', 'a1')];
    await writeBatch(client, { batch: 'img-dn-1', mode: 'create', rows, links: [], keys: { golden: [], gers: [] }, manifest: base, activate: true });
    expect(db.batches.get('img-dn-1')?.is_active).toBe(true);
    await expect(writeBatch(client, { batch: 'img-dn-1', mode: 'create', rows, links: [], keys: { golden: [], gers: [] }, manifest: base })).rejects.toThrow(/--replace/);
    expect(db.log.at(-1)).toBe('ROLLBACK');
    await writeBatch(client, { batch: 'img-dn-1', mode: 'replace', rows: [media('dn-a', 'golden', 'hero', 'a2')], links: [], keys: { golden: [], gers: [] }, manifest: base });
    expect(db.media.map((r) => r.sha256)).toEqual(['a2']);
    expect(db.log).toContain(SQL.dropBatch);
  });
});
