import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACE_SEARCH_CATEGORIES,
  PLACE_SEARCH_CATEGORIES,
  POI_CATEGORIES,
  POI_SEARCH_CATEGORIES,
  isPoiCategory,
  poiCategoryGroup,
  poiCategoryLabel,
} from './poi-taxonomy';
import { VN_PROVINCES, isVnProvinceCode, vnProvinceName } from './vn-provinces';

const OVERTURE_CODES = [
  'accommodation',
  'bar_nightlife',
  'shopping',
  'entertainment',
  'sports_recreation',
  'wellness',
  'transport_hub',
  'traveler_service',
  'other',
];

describe('POI taxonomy', () => {
  it('keeps the 26 MAP-POI categories and adds the 9 Overture codes', () => {
    expect(POI_CATEGORIES).toHaveLength(35);
    expect(POI_CATEGORIES.slice(26)).toEqual(OVERTURE_CODES);
    expect(poiCategoryLabel('market')).toBe('Chợ');
    expect(poiCategoryLabel('bridge')).toBe('Cầu tham quan');
    expect(poiCategoryLabel('accommodation')).toBe('Lưu trú');
    expect(poiCategoryLabel('traveler_service')).toBe('Tiện ích cho khách');
    expect(poiCategoryLabel('other')).toBe('Khác');
    expect(poiCategoryLabel('unknown')).toBe('');
    expect(isPoiCategory('toString')).toBe(false);
  });
  it('maps public search categories onto the taxonomy', () => {
    expect(POI_SEARCH_CATEGORIES.tourism).toHaveLength(23);
    expect(POI_SEARCH_CATEGORIES.tourism).not.toContain('restaurant');
    expect(POI_SEARCH_CATEGORIES.tourism).not.toContain('cafe');
    expect(POI_SEARCH_CATEGORIES.tourism).not.toContain('food_street');
    expect(POI_SEARCH_CATEGORIES.tourism).toContain('market');
    for (const code of OVERTURE_CODES) expect(POI_SEARCH_CATEGORIES.tourism).not.toContain(code);
    expect(POI_SEARCH_CATEGORIES.restaurant).toEqual(['restaurant', 'food_street']);
    expect(POI_SEARCH_CATEGORIES.cafe).toEqual(['cafe']);
    expect(POI_SEARCH_CATEGORIES.accommodation).toEqual(['accommodation']);
    expect(POI_SEARCH_CATEGORIES.entertainment).toEqual(['entertainment', 'sports_recreation']);
    expect(POI_SEARCH_CATEGORIES.services).toEqual(['traveler_service']);
    expect(PLACE_SEARCH_CATEGORIES).toEqual([
      'tourism',
      'restaurant',
      'cafe',
      'accommodation',
      'nightlife',
      'shopping',
      'entertainment',
      'wellness',
      'transport',
      'services',
      'other',
    ]);
    expect(DEFAULT_PLACE_SEARCH_CATEGORIES).toEqual(['tourism', 'restaurant', 'cafe', 'accommodation']);
  });
  it('puts every code in exactly one search group', () => {
    for (const code of POI_CATEGORIES) {
      const groups = PLACE_SEARCH_CATEGORIES.filter((group) =>
        (POI_SEARCH_CATEGORIES[group] as readonly string[]).includes(code),
      );
      expect(groups, code).toHaveLength(1);
      expect(poiCategoryGroup(code)).toBe(groups[0]);
    }
    expect(poiCategoryGroup('beach')).toBe('tourism');
    expect(poiCategoryGroup('wellness')).toBe('wellness');
    expect(poiCategoryGroup('nope')).toBeNull();
  });
});

describe('VN provinces', () => {
  it('lists the 34 province-level units with two-digit codes', () => {
    expect(Object.keys(VN_PROVINCES)).toHaveLength(34);
    for (const code of Object.keys(VN_PROVINCES)) expect(code).toMatch(/^\d{2}$/);
    expect(vnProvinceName('48')).toBe('Đà Nẵng');
    expect(vnProvinceName('56')).toBe('Khánh Hòa');
    expect(vnProvinceName('79')).toBe('Hồ Chí Minh');
    expect(vnProvinceName('02')).toBe('');
    expect(vnProvinceName(null)).toBe('');
    expect(isVnProvinceCode('hasOwnProperty')).toBe(false);
  });
});
