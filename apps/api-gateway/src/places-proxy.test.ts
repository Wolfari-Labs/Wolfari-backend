import { describe, expect, it } from 'vitest';
import { BboxError, PLACE_SEARCH_GROUPS, parseBbox, publicPlace } from './places-proxy';

describe('Places bbox parameter (POI-OVERTURE O8)', () => {
  it('parses minLon,minLat,maxLon,maxLat', () => {
    expect(parseBbox('108.1,16.0,108.3,16.1')).toEqual({
      min_longitude: 108.1,
      min_latitude: 16,
      max_longitude: 108.3,
      max_latitude: 16.1,
    });
    expect(parseBbox(null)).toBeUndefined();
  });
  it.each(['', '1,2,3', 'a,b,c,d', '108.3,16,108.1,16.1', '108,16,108,16.1', '200,0,201,1', '1e1,1,2,2'])(
    'rejects %j as INVALID_BBOX',
    (value) => {
      expect(() => parseBbox(value)).toThrow(BboxError);
      expect(() => parseBbox(value)).toThrow('INVALID_BBOX');
    },
  );
  it('rejects frames wider than 2° as BBOX_TOO_LARGE', () => {
    expect(() => parseBbox('105,20,107.5,21')).toThrow('BBOX_TOO_LARGE');
    expect(() => parseBbox('105,19,106,21.5')).toThrow('BBOX_TOO_LARGE');
    expect(parseBbox('105,19,107,21')).toBeTruthy();
  });
  it('accepts the documented category groups', () => {
    expect(PLACE_SEARCH_GROUPS).toContain('services');
    expect(PLACE_SEARCH_GROUPS).toContain('all');
    expect(PLACE_SEARCH_GROUPS).not.toContain('');
  });
});

describe('publicPlace (POI-OVERTURE fields)', () => {
  it('exposes Overture provenance and province', () => {
    const place = publicPlace({
      id: 'ov-1',
      name: 'Hồ Hoàn Kiếm',
      provider: 'WOLFARI',
      tier: 9,
      source_dataset: 'overture',
      category: 'nature_area',
      category_group: 'tourism',
      province_code: '01',
      province_name: 'Hà Nội',
      confidence: 0.77,
      _confidence: 'confidence',
      data_release: '2026-10-21.0',
      fetched_at: { seconds: '1795530600', nanos: 0 },
    });
    expect(place).toMatchObject({
      source_dataset: 'overture',
      category_group: 'tourism',
      province_code: '01',
      province_name: 'Hà Nội',
      confidence: 0.77,
      data_release: '2026-10-21.0',
      fetched_at: '2026-11-24T14:30:00.000Z',
    });
    expect(place).not.toHaveProperty('_confidence');
  });
  it('defaults the new fields for golden and Geoapify rows', () => {
    expect(publicPlace({ id: 'dn-cho-han', provider: 'WOLFARI', tier: 1 })).toMatchObject({
      source_dataset: 'golden',
      province_name: null,
      confidence: null,
      data_release: null,
      fetched_at: null,
    });
    expect(publicPlace({ id: 'g', provider: 'GEOAPIFY' })).toMatchObject({
      source_dataset: 'geoapify',
      category_group: null,
    });
  });
});
