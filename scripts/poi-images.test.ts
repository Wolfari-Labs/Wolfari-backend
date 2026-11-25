import { describe, expect, it } from 'vitest';
import {
  attributionLine, cellCircle, cellsFor, linkEntities, matchRadius, mentionsName, nameScore, normalizeLicense,
  normalizeAuthor, otherFeature, plainText, qualityScore, scoreCandidate, selectPhotos, semanticScore, splitCell, typeCompatible,
} from './poi/images/lib.mjs';

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
