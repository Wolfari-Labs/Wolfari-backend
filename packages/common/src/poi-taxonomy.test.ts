import { describe, expect, it } from 'vitest';
import {
  POI_CATEGORIES,
  POI_SEARCH_CATEGORIES,
  isPoiCategory,
  poiCategoryLabel,
} from './poi-taxonomy';

describe('POI taxonomy', () => {
  it('has the 26 MAP-POI categories with Vietnamese labels', () => {
    expect(POI_CATEGORIES).toHaveLength(26);
    expect(poiCategoryLabel('market')).toBe('Chợ');
    expect(poiCategoryLabel('bridge')).toBe('Cầu tham quan');
    expect(poiCategoryLabel('unknown')).toBe('');
    expect(isPoiCategory('toString')).toBe(false);
  });
  it('maps public search categories onto the taxonomy', () => {
    expect(POI_SEARCH_CATEGORIES.tourism).toHaveLength(23);
    expect(POI_SEARCH_CATEGORIES.tourism).not.toContain('restaurant');
    expect(POI_SEARCH_CATEGORIES.tourism).not.toContain('cafe');
    expect(POI_SEARCH_CATEGORIES.tourism).not.toContain('food_street');
    expect(POI_SEARCH_CATEGORIES.tourism).toContain('market');
    expect(POI_SEARCH_CATEGORIES.restaurant).toEqual(['restaurant', 'food_street']);
    expect(POI_SEARCH_CATEGORIES.cafe).toEqual(['cafe']);
    expect(POI_SEARCH_CATEGORIES.accommodation).toEqual([]);
  });
});
