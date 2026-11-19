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
  // POI-OVERTURE (additive): broad codes for the nationwide Overture tier.
  accommodation: 'Lưu trú',
  bar_nightlife: 'Bar và giải trí đêm',
  shopping: 'Mua sắm',
  entertainment: 'Giải trí',
  sports_recreation: 'Thể thao và vận động',
  wellness: 'Spa, massage và chăm sóc',
  transport_hub: 'Sân bay, ga, bến xe, bến tàu',
  traveler_service: 'Tiện ích cho khách',
  other: 'Khác',
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

/** The 23 MAP-POI sightseeing codes (fixed list: new codes never join tourism implicitly). */
const TOURISM: readonly PoiCategory[] = [
  'museum',
  'historic',
  'attraction',
  'viewpoint',
  'park',
  'beach',
  'temple',
  'gallery',
  'zoo',
  'theme_park',
  'old_quarter',
  'craft_village',
  'market',
  'nature_area',
  'performance_venue',
  'water_park',
  'playground',
  'walking_street',
  'bridge',
  'cave',
  'waterfall',
  'campground',
  'trailhead',
];
/** Public search `category` (Places API) → POI taxonomy codes searched in the Wolfari catalogue. */
export const POI_SEARCH_CATEGORIES = Object.freeze({
  tourism: Object.freeze([...TOURISM]),
  restaurant: Object.freeze(['restaurant', 'food_street'] as PoiCategory[]),
  cafe: Object.freeze(['cafe'] as PoiCategory[]),
  accommodation: Object.freeze(['accommodation'] as PoiCategory[]),
  nightlife: Object.freeze(['bar_nightlife'] as PoiCategory[]),
  shopping: Object.freeze(['shopping'] as PoiCategory[]),
  entertainment: Object.freeze(['entertainment', 'sports_recreation'] as PoiCategory[]),
  wellness: Object.freeze(['wellness'] as PoiCategory[]),
  transport: Object.freeze(['transport_hub'] as PoiCategory[]),
  services: Object.freeze(['traveler_service'] as PoiCategory[]),
  other: Object.freeze(['other'] as PoiCategory[]),
} satisfies Record<string, readonly PoiCategory[]>);
export type PlaceSearchCategory = keyof typeof POI_SEARCH_CATEGORIES;
export const PLACE_SEARCH_CATEGORIES = Object.freeze(
  Object.keys(POI_SEARCH_CATEGORIES) as PlaceSearchCategory[],
);
/** Groups searched when the client sends no `category`. */
export const DEFAULT_PLACE_SEARCH_CATEGORIES: readonly PlaceSearchCategory[] = Object.freeze([
  'tourism',
  'restaurant',
  'cafe',
  'accommodation',
]);

/** Search group of a taxonomy code; every code belongs to exactly one group. */
export function poiCategoryGroup(code: string): PlaceSearchCategory | null {
  for (const group of PLACE_SEARCH_CATEGORIES)
    if ((POI_SEARCH_CATEGORIES[group] as readonly string[]).includes(code)) return group;
  return null;
}

export function isPoiCategory(code: unknown): code is PoiCategory {
  return typeof code === 'string' && Object.hasOwn(POI_CATEGORY_LABELS, code);
}
export function poiCategoryLabel(code: string): string {
  return isPoiCategory(code) ? POI_CATEGORY_LABELS[code] : '';
}
