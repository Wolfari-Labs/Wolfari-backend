// POI-OVERTURE O2: the one place that decides what happens to an Overture category.
//
// A category is the Overture `taxonomy.hierarchy` joined with '>' (release 2026-10-21.0,
// schema v2.0.0), e.g. 'food_and_drink>casual_eatery>cafe'. Rules match a whole path or any
// path below it; an entry ending in '$' matches only that exact path. The most specific
// (longest) matching rule wins, and KEEP beats EXCLUDE beats MAP at equal or any length.
//
// To rescue a category: delete its line from EXCLUDE (or add it to KEEP), then re-run the
// pipeline from the raw file (`corepack pnpm poi:overture --from-raw`); nothing is downloaded.

/** Never dropped, even when an EXCLUDE rule covers a parent path. */
export const KEEP = Object.freeze({
  'community_and_government>government_office>embassy': 'traveler_service',
  'services_and_business>financial_service>atm': 'traveler_service',
  'services_and_business>financial_service>currency_exchange': 'traveler_service',
  'services_and_business>financial_service>money_transfer_service': 'traveler_service',
  'services_and_business>corporate_or_business_office>travel_company': 'traveler_service',
  'services_and_business>corporate_or_business_office>ferry_boat_company': 'traveler_service',
  'services_and_business>shipping_or_delivery_service>post_office': 'traveler_service',
  'services_and_business>agricultural_service>farm': 'other',
  'education>library': 'other',
  'education>place_of_learning>specialty_school>cooking_school': 'entertainment',
});

/** Reason code → [Vietnamese label, category paths]. Only categories certainly unrelated to travel. */
export const EXCLUDE = Object.freeze({
  office_b2b: [
    'Văn phòng công ty, doanh nghiệp B2B, dịch vụ doanh nghiệp',
    [
      'services_and_business$',
      'services_and_business>b2b_service',
      'services_and_business>corporate_or_business_office',
      'services_and_business>professional_service',
      'services_and_business>agricultural_service',
      'services_and_business>design_service',
      'services_and_business>media_service',
      'services_and_business>environmental_or_ecological_service',
      'services_and_business>telecommunications_service',
      'services_and_business>security_service',
      'community_and_government>public_utility',
    ],
  ],
  industrial: [
    'Nhà máy, xưởng sản xuất, kho bãi, công trường, khu công nghiệp',
    [
      'services_and_business>b2b_service>manufacturer',
      'services_and_business>b2b_service>b2b_industrial_and_machine_service',
      'services_and_business>b2b_service>commercial_industrial',
      'services_and_business>b2b_service>b2b_transportation_and_storage_service>b2b_storage',
      'services_and_business>industrial_facility_or_service',
      'services_and_business>storage_facility',
      'services_and_business>technical_service>machine_shop',
    ],
  ],
  real_estate: [
    'Bất động sản, môi giới nhà đất, dự án nhà ở',
    [
      'services_and_business>real_estate_service',
      'services_and_business>financial_service>real_estate_investment',
    ],
  ],
  government: [
    'Cơ quan nhà nước, đoàn thể, công an, quân đội',
    [
      'community_and_government>government_office',
      'community_and_government>public_safety_service',
      'community_and_government>military_site',
      'community_and_government>civic_organization',
      'community_and_government>social_or_community_service>youth_organization',
      'community_and_government>social_or_community_service>housing_authority',
    ],
  ],
  education: [
    'Trường học, trung tâm đào tạo, trung tâm ngoại ngữ',
    ['education', 'services_and_business>family_service>child_care_and_day_care'],
  ],
  housing: [
    'Nhà ở, chung cư, khu dân cư, ký túc xá',
    ['services_and_business>housing_or_property_service'],
  ],
  vehicle: [
    'Sửa xe, đại lý/showroom ô tô – xe máy, phụ tùng',
    [
      'travel_and_transportation>vehicle_service',
      'shopping>vehicle_dealer',
      'shopping>specialty_store>vehicle_parts_store',
      'services_and_business>technical_service>bike_repair_maintenance',
      'services_and_business>b2b_service>b2b_transportation_and_storage_service>truck_and_industrial_vehicle_services',
    ],
  ],
  construction: [
    'Vật liệu xây dựng, kim khí, điện nước, nội thất công trình',
    [
      'shopping>specialty_store>hardware_home_and_garden_store$',
      'shopping>specialty_store>hardware_home_and_garden_store>building_supply_store',
      'shopping>specialty_store>hardware_home_and_garden_store>hardware_store',
      'shopping>specialty_store>hardware_home_and_garden_store>home_improvement_store',
      'shopping>specialty_store>hardware_home_and_garden_store>furniture_store',
      'shopping>specialty_store>hardware_home_and_garden_store>mattress_store',
      'shopping>specialty_store>hardware_home_and_garden_store>carpet_store',
      'shopping>specialty_store>hardware_home_and_garden_store>lighting_store',
      'services_and_business>building_or_construction_service',
      'services_and_business>home_service>interior_design',
    ],
  ],
  legal_finance: [
    'Luật, kế toán, bảo hiểm, tài chính tiêu dùng, cầm đồ',
    [
      'services_and_business>legal_service',
      'services_and_business>financial_service',
      'shopping>second_hand_store>pawn_shop',
    ],
  ],
  recruitment: [
    'Tuyển dụng, việc làm',
    [
      'services_and_business>professional_service>employment_agency',
      'services_and_business>b2b_service>b2b_office_and_professional_service>b2b_human_resource_service',
      'services_and_business>b2b_service>b2b_office_and_professional_service>b2b_business_management_service>b2b_executive_search_consultants',
    ],
  ],
  logistics: [
    'Logistics, vận tải hàng hóa, chuyển phát',
    [
      'services_and_business>b2b_service>b2b_transportation_and_storage_service',
      'services_and_business>shipping_or_delivery_service',
      'services_and_business>home_service>mover',
      'lifestyle_services>food_service>food_delivery_service',
    ],
  ],
  printing_ads: [
    'In ấn, quảng cáo, marketing',
    [
      'services_and_business>printing_service',
      'services_and_business>professional_service>advertising_agency',
      'services_and_business>professional_service>marketing_agency',
      'services_and_business>professional_service>social_media_agency',
      'services_and_business>professional_service>internet_marketing_service',
      'services_and_business>professional_service>merchandising_service',
      'services_and_business>b2b_service>b2b_office_and_professional_service>b2b_advertising_and_marketing_service',
      'services_and_business>design_service>sign_making',
      'services_and_business>design_service>graphic_designer',
    ],
  ],
  cleaning_technical: [
    'Dịch vụ vệ sinh, kỹ thuật, lắp đặt, sửa chữa điện tử',
    [
      'services_and_business>home_service',
      'services_and_business>technical_service',
      'services_and_business>professional_service>cleaning_service',
    ],
  ],
  bank_branch: [
    'Chi nhánh ngân hàng (giữ ATM)',
    ['services_and_business>financial_service>bank_or_credit_union'],
  ],
});

/** Record-level reasons (not category based). */
export const RECORD_REASONS = Object.freeze({
  closed: 'Đóng cửa (vĩnh viễn hoặc tạm thời)',
  bad_name: 'Tên rỗng / chỉ số / chỉ là địa chỉ',
  outside_vn: 'Ngoài polygon Việt Nam (nước khác trong bbox)',
});

/** Kept categories → Wolfari taxonomy code. Unmatched kept categories become 'other'. */
export const MAP = Object.freeze({
  arts_and_entertainment: 'entertainment',
  'arts_and_entertainment>museum': 'museum',
  'arts_and_entertainment>arts_and_crafts_space': 'gallery',
  'arts_and_entertainment>animal_attraction': 'zoo',
  'arts_and_entertainment>amusement_attraction': 'theme_park',
  'arts_and_entertainment>performing_arts_venue': 'performance_venue',
  'arts_and_entertainment>performing_arts_venue>music_venue>karaoke_venue': 'entertainment',
  'arts_and_entertainment>nightlife_venue': 'bar_nightlife',
  'arts_and_entertainment>science_attraction': 'attraction',
  'arts_and_entertainment>rural_attraction': 'attraction',
  'arts_and_entertainment>spiritual_advising': 'other',
  'community_and_government>public_facility': 'attraction',
  'community_and_government>public_facility>public_restroom': 'traveler_service',
  cultural_and_historic: 'historic',
  'cultural_and_historic>place_of_worship': 'temple',
  'cultural_and_historic>religious_organization': 'temple',
  'cultural_and_historic>cultural_center': 'attraction',
  food_and_drink: 'restaurant',
  'food_and_drink>casual_eatery>cafe': 'cafe',
  'food_and_drink>casual_eatery>cafe>internet_cafe': 'entertainment',
  'food_and_drink>casual_eatery>bakery': 'cafe',
  'food_and_drink>casual_eatery>dessert_shop': 'cafe',
  'food_and_drink>casual_eatery>candy_store': 'shopping',
  'food_and_drink>non_alcoholic_beverage_venue': 'cafe',
  'food_and_drink>alcoholic_beverage_venue': 'bar_nightlife',
  geographic_entities: 'nature_area',
  'geographic_entities>land_feature>beach': 'beach',
  'geographic_entities>land_feature>cave': 'cave',
  'geographic_entities>water_feature>waterfall': 'waterfall',
  'geographic_entities>built_feature': 'attraction',
  'geographic_entities>built_feature>bridge': 'bridge',
  health_care: 'traveler_service',
  'lifestyle_services>wellness_service': 'wellness',
  'lifestyle_services>personal_or_beauty_service': 'wellness',
  lodging: 'accommodation',
  'lodging>campground': 'campground',
  'services_and_business>laundry_service': 'traveler_service',
  'services_and_business>rental_service': 'traveler_service',
  shopping: 'shopping',
  'shopping>market': 'market',
  'shopping>specialty_store>pharmacy_and_drug_store': 'traveler_service',
  sports_and_recreation: 'sports_recreation',
  'sports_and_recreation>park': 'park',
  'sports_and_recreation>park>playground': 'playground',
  'sports_and_recreation>park>national_park': 'nature_area',
  'sports_and_recreation>park>water_park': 'water_park',
  'sports_and_recreation>recreational_trail_or_path': 'trailhead',
  travel_and_transportation: 'traveler_service',
  'travel_and_transportation>air_transport_facility_or_service>airport': 'transport_hub',
  'travel_and_transportation>ground_transport_facility_or_service': 'transport_hub',
  'travel_and_transportation>ground_transport_facility_or_service>taxi_or_ride_share_service':
    'traveler_service',
  'travel_and_transportation>water_transport_facility_or_service': 'transport_hub',
});

/** Activity type suggested by a taxonomy code (null = none). */
export const ACTIVITY_TYPE = Object.freeze({
  museum: 'MUSEUM',
  historic: 'CULTURE',
  attraction: 'SIGHTSEEING',
  viewpoint: 'SIGHTSEEING',
  park: 'OUTDOOR',
  beach: 'BEACH',
  temple: 'TEMPLE',
  gallery: 'CULTURE',
  zoo: 'ENTERTAINMENT',
  theme_park: 'ENTERTAINMENT',
  market: 'SHOPPING',
  nature_area: 'OUTDOOR',
  performance_venue: 'SHOW',
  restaurant: 'FOOD',
  cafe: 'FOOD',
  water_park: 'ENTERTAINMENT',
  playground: 'ENTERTAINMENT',
  bridge: 'SIGHTSEEING',
  cave: 'OUTDOOR',
  waterfall: 'OUTDOOR',
  campground: 'OUTDOOR',
  trailhead: 'OUTDOOR',
  bar_nightlife: 'ENTERTAINMENT',
  shopping: 'SHOPPING',
  entertainment: 'ENTERTAINMENT',
  sports_recreation: 'OUTDOOR',
});

const covers = (rule, path) =>
  rule.endsWith('$') ? path === rule.slice(0, -1) : path === rule || path.startsWith(`${rule}>`);
const longest = (rules, path) => {
  let best = null;
  for (const rule of rules)
    if (covers(rule, path) && (!best || rule.length > best.length)) best = rule;
  return best;
};

/**
 * Classify one Overture category path (hierarchy joined by '>', or null when the record has
 * no taxonomy). Returns { action: 'keep', code, rule } or { action: 'exclude', reason, rule }.
 */
export function classifyCategory(path) {
  if (!path) return { action: 'keep', code: 'other', rule: null };
  const keep = longest(Object.keys(KEEP), path);
  if (keep) return { action: 'keep', code: KEEP[keep], rule: keep };
  let excluded = null;
  for (const [reason, [, rules]] of Object.entries(EXCLUDE)) {
    const rule = longest(rules, path);
    if (rule && (!excluded || rule.length > excluded.rule.length)) excluded = { reason, rule };
  }
  if (excluded) return { action: 'exclude', ...excluded };
  const mapped = longest(Object.keys(MAP), path);
  return { action: 'keep', code: mapped ? MAP[mapped] : 'other', rule: mapped };
}

export function activityTypeFor(code) {
  return ACTIVITY_TYPE[code] ?? null;
}

/** Fold a name for comparisons: no accents, đ → d, lower case, alphanumerics and single spaces. */
export function foldText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STREET_PREFIX = /^(so nha|so|hem|kiet|ngo|ngach|lo|to)\s+\d/;
const HOUSE_NUMBER = /^\d+[a-z]?([/-]\d+[a-z]?)*\s/;
/**
 * True when a name cannot identify a place: empty, only digits/punctuation, or just an address
 * (identical to the record's street address, or "số 12 …"/"hẻm 5 …"/"123 Lê Lợi" shaped and
 * contained in that address).
 */
export function isUnusableName(name, address) {
  const folded = foldText(name);
  if (!/\p{L}/u.test(folded)) return true;
  const street = foldText(address);
  if (street && folded === street) return true;
  if (STREET_PREFIX.test(folded)) return true;
  return Boolean(street && HOUSE_NUMBER.test(folded) && street.startsWith(folded));
}
