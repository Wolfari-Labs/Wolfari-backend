import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { applyOverride, parseOverrides, overrideTemplate } from './poi/overrides.mjs';
// @ts-expect-error plain ESM script without type declarations
import { parseCsv, serializeCsv } from './poi/csv.mjs';

const header = 'wolfari_key,lat,lon,coord_verified,note';
const keys = new Set(['dn-cho-han', 'dn-cau-tinh-yeu', 'dn-pho-co-hoi-an']);
const golden = {
  wolfari_key: 'dn-cho-han',
  lat: '16.068352',
  lon: '108.224283',
  coord_source: 'nominatim',
  coord_verified: 'false',
  osm_ref: 'way/204885903',
};

describe('POI coordinate overrides', () => {
  it('ignores untouched template rows and keeps reviewer notes', () => {
    const { overrides, errors } = parseOverrides(
      `${header}\ndn-cho-han,,,,\ndn-pho-co-hoi-an,,,true,ghim đúng\n`,
      keys,
    );
    expect(errors).toEqual([]);
    expect([...overrides.keys()]).toEqual(['dn-pho-co-hoi-an']);
    expect(overrides.get('dn-pho-co-hoi-an')).toEqual({ coord_verified: true, note: 'ghim đúng' });
  });
  it('confirming the current pin only flips coord_verified and keeps the OSM reference', () => {
    expect(applyOverride(golden, { coord_verified: true, note: '' })).toEqual({
      ...golden,
      coord_verified: 'true',
    });
  });
  it('new coordinates become manual, drop osm_ref and stay unverified unless stated', () => {
    const { overrides } = parseOverrides(
      `${header}\ndn-cho-han,16.0684,108.2243,,ứng viên 1\n`,
      keys,
    );
    expect(applyOverride(golden, overrides.get('dn-cho-han'))).toEqual({
      ...golden,
      lat: '16.068400',
      lon: '108.224300',
      coord_source: 'manual',
      osm_ref: '',
      coord_verified: 'false',
    });
    const verified = parseOverrides(`${header}\ndn-cau-tinh-yeu,16.0612,108.2295,TRUE,\n`, keys);
    expect(
      applyOverride(
        { wolfari_key: 'dn-cau-tinh-yeu', lat: '', lon: '' },
        verified.overrides.get('dn-cau-tinh-yeu'),
      ),
    ).toMatchObject({
      lat: '16.061200',
      lon: '108.229500',
      coord_verified: 'true',
      coord_source: 'manual',
    });
  });
  it.each([
    ['dn-unknown,16.06,108.22,true,', 'không có trong golden list'],
    ['dn-cho-han,16.06,,true,', 'cả lat và lon'],
    ['dn-cho-han,108.22,16.06,true,', 'ngoài bbox'],
    ['dn-cho-han,abc,108.22,,', 'không phải số'],
    ['dn-cho-han,,,yes,', 'coord_verified'],
  ])('rejects %s', (row, message) => {
    const { overrides, errors } = parseOverrides(`${header}\n${row}\n`, keys);
    expect(overrides.size).toBe(0);
    expect(errors.join(' ')).toContain(message);
  });
  it('rejects duplicate keys and a wrong header', () => {
    expect(
      parseOverrides(`${header}\ndn-cho-han,,,true,\ndn-cho-han,,,false,\n`, keys).errors.join(' '),
    ).toContain('hai lần');
    expect(parseOverrides('key,lat,lon\n', keys).errors[0]).toContain('header');
  });
  it('template has one empty row per golden key and round-trips through CSV', () => {
    const text = serializeCsv(
      header.split(','),
      overrideTemplate([{ wolfari_key: 'dn-cho-han' }, { wolfari_key: 'dn-cau-tinh-yeu' }]),
    );
    expect(text).toBe(`${header}\ndn-cho-han,,,,\ndn-cau-tinh-yeu,,,,\n`);
    expect(parseCsv(text).records).toHaveLength(2);
    expect(parseOverrides(text, keys).overrides.size).toBe(0);
  });
});
