/** Wolfari POI taxonomy (MAP-POI §8): stable code → Vietnamese label. */
export const POI_CATEGORY_LABELS = Object.freeze({
  museum: 'Bảo tàng',
  historic: 'Di tích',
  attraction: 'Điểm tham quan',
  viewpoint: 'Điểm ngắm cảnh',
  park: 'Công viên',
  beach: 'Bãi biển',
  temple: 'Đền, chùa và nơi thờ tự',
  gallery: 'Phòng trưng bày',
  zoo: 'Vườn thú và thủy cung',
  theme_park: 'Khu vui chơi lớn',
  old_quarter: 'Phố cổ và khu di sản đô thị',
  craft_village: 'Làng nghề',
  market: 'Chợ',
  nature_area: 'Khu thiên nhiên',
  performance_venue: 'Điểm biểu diễn văn hóa',
  restaurant: 'Nhà hàng',
  cafe: 'Cà phê',
  food_street: 'Khu ẩm thực',
  water_park: 'Công viên nước',
  playground: 'Sân chơi',
  walking_street: 'Phố đi bộ và đường dạo',
  bridge: 'Cầu tham quan',
  cave: 'Hang động',
  waterfall: 'Thác nước',
  campground: 'Khu cắm trại',
  trailhead: 'Điểm bắt đầu đường mòn',
} as const);
export type PoiCategory = keyof typeof POI_CATEGORY_LABELS;
export const POI_CATEGORIES = Object.freeze(Object.keys(POI_CATEGORY_LABELS) as PoiCategory[]);

/** Activity types a POI may suggest for a Plan activity. Clients show unknown values as "Khác". */
export const POI_ACTIVITY_TYPES = Object.freeze([
  'SIGHTSEEING',
  'BEACH',
  'TEMPLE',
  'CHURCH',
  'MUSEUM',
  'SHOPPING',
  'FOOD',
  'WALKING',
  'ENTERTAINMENT',
  'SHOW',
  'CULTURE',
  'OUTDOOR',
] as const);
export type PoiActivityType = (typeof POI_ACTIVITY_TYPES)[number];

const FOOD: readonly PoiCategory[] = ['restaurant', 'cafe', 'food_street'];
/** Public search `category` (Places API) → POI taxonomy codes searched in the Wolfari catalogue. */
export const POI_SEARCH_CATEGORIES = Object.freeze({
  tourism: Object.freeze(POI_CATEGORIES.filter((code) => !FOOD.includes(code))),
  restaurant: Object.freeze(['restaurant', 'food_street'] as PoiCategory[]),
  cafe: Object.freeze(['cafe'] as PoiCategory[]),
  accommodation: Object.freeze([] as PoiCategory[]),
} satisfies Record<string, readonly PoiCategory[]>);
export type PlaceSearchCategory = keyof typeof POI_SEARCH_CATEGORIES;

export function isPoiCategory(code: unknown): code is PoiCategory {
  return typeof code === 'string' && Object.hasOwn(POI_CATEGORY_LABELS, code);
}
export function poiCategoryLabel(code: string): string {
  return isPoiCategory(code) ? POI_CATEGORY_LABELS[code] : '';
}
