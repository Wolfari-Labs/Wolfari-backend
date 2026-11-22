import { describe, expect, it } from 'vitest';
import { POI_ACTIVITY_TYPES, isPoiCategory, poiCategoryGroup } from '../packages/common/src/poi-taxonomy';
import {
  ACTIVITY_TYPE,
  EXCLUDE,
  KEEP,
  MAP,
  activityTypeFor,
  classifyCategory,
  foldText,
  isUnusableName,
  // @ts-expect-error plain ESM script without type declarations
} from './poi/overture-taxonomy.mjs';

const path = (value: string) => value.split(' > ').join('>');
const keep = (value: string) => classifyCategory(value === '' ? null : path(value));

// Real category paths from Overture 2026-10-21.0 (Vietnam bbox) → expected Wolfari outcome.
const KEPT: [string, string][] = [
  ['food_and_drink > restaurant > vietnamese_restaurant', 'restaurant'],
  ['food_and_drink > casual_eatery > diner', 'restaurant'],
  ['food_and_drink > casual_eatery > fast_food_restaurant', 'restaurant'],
  ['food_and_drink > casual_eatery > cafe', 'cafe'],
  ['food_and_drink > casual_eatery > bakery', 'cafe'],
  ['food_and_drink > non_alcoholic_beverage_venue > coffee_shop', 'cafe'],
  ['food_and_drink > non_alcoholic_beverage_venue > bubble_tea_shop', 'cafe'],
  ['food_and_drink > alcoholic_beverage_venue > bar > pub', 'bar_nightlife'],
  ['food_and_drink > alcoholic_beverage_venue > beer_garden', 'bar_nightlife'],
  ['arts_and_entertainment > nightlife_venue > dance_club', 'bar_nightlife'],
  ['lodging > hotel', 'accommodation'],
  ['lodging > hostel', 'accommodation'],
  ['lodging > resort', 'accommodation'],
  ['lodging > private_lodging > guest_house', 'accommodation'],
  ['lodging > campground', 'campground'],
  ['cultural_and_historic > historic_site', 'historic'],
  ['cultural_and_historic > memorial_site > monument', 'historic'],
  ['cultural_and_historic > place_of_worship > buddhist_place_of_worship', 'temple'],
  ['cultural_and_historic > place_of_worship > christian_place_of_worship > roman_catholic_place_of_worship', 'temple'],
  ['arts_and_entertainment > museum > history_museum', 'museum'],
  ['arts_and_entertainment > arts_and_crafts_space > art_gallery', 'gallery'],
  ['arts_and_entertainment > animal_attraction > zoo', 'zoo'],
  ['arts_and_entertainment > animal_attraction > aquarium', 'zoo'],
  ['arts_and_entertainment > amusement_attraction > amusement_park', 'theme_park'],
  ['arts_and_entertainment > performing_arts_venue > theatre_venue', 'performance_venue'],
  ['arts_and_entertainment > performing_arts_venue > music_venue > karaoke_venue', 'entertainment'],
  ['arts_and_entertainment > movie_theater', 'entertainment'],
  ['arts_and_entertainment > gaming_venue > arcade', 'entertainment'],
  ['geographic_entities > land_feature > beach', 'beach'],
  ['geographic_entities > land_feature > mountain', 'nature_area'],
  ['geographic_entities > land_feature > cave', 'cave'],
  ['geographic_entities > water_feature > waterfall', 'waterfall'],
  ['geographic_entities > water_feature > lake', 'nature_area'],
  ['geographic_entities > built_feature > bridge', 'bridge'],
  ['sports_and_recreation > park', 'park'],
  ['sports_and_recreation > park > national_park', 'nature_area'],
  ['sports_and_recreation > park > water_park', 'water_park'],
  ['sports_and_recreation > park > playground', 'playground'],
  ['sports_and_recreation > recreational_trail_or_path > hiking_trail', 'trailhead'],
  ['sports_and_recreation > sport_or_fitness_facility > gym', 'sports_recreation'],
  ['sports_and_recreation > sport_or_fitness_facility > golf_course', 'sports_recreation'],
  ['shopping > market > night_market', 'market'],
  ['shopping > shopping_mall', 'shopping'],
  ['shopping > fashion_and_apparel_store > clothing_store', 'shopping'],
  ['shopping > specialty_store > souvenir_store', 'shopping'],
  ['shopping > specialty_store > hardware_home_and_garden_store > home_goods_store', 'shopping'],
  ['shopping > specialty_store > pharmacy_and_drug_store > pharmacy', 'traveler_service'],
  ['lifestyle_services > wellness_service > spa', 'wellness'],
  ['lifestyle_services > wellness_service > massage_therapy', 'wellness'],
  ['lifestyle_services > personal_or_beauty_service > nail_salon', 'wellness'],
  ['travel_and_transportation > air_transport_facility_or_service > airport', 'transport_hub'],
  ['travel_and_transportation > ground_transport_facility_or_service > public_transit_facility_or_service > bus_station', 'transport_hub'],
  ['travel_and_transportation > ground_transport_facility_or_service > rail_facility_or_service > train_station', 'transport_hub'],
  ['travel_and_transportation > ground_transport_facility_or_service > taxi_or_ride_share_service > taxi_service', 'traveler_service'],
  ['travel_and_transportation > fueling_station > gas_station', 'traveler_service'],
  ['travel_and_transportation > travel_service > tour_operator', 'traveler_service'],
  ['health_care > hospital', 'traveler_service'],
  ['health_care > outpatient_care_facility > dental_clinic', 'traveler_service'],
  ['services_and_business > financial_service > atm', 'traveler_service'],
  ['services_and_business > financial_service > currency_exchange', 'traveler_service'],
  ['community_and_government > government_office > embassy', 'traveler_service'],
  ['services_and_business > rental_service > vehicle_rental_service > motorcycle_rental_service', 'traveler_service'],
  ['services_and_business > laundry_service > laundromat', 'traveler_service'],
  ['services_and_business > shipping_or_delivery_service > post_office', 'traveler_service'],
  ['services_and_business > agricultural_service > farm', 'other'],
  ['services_and_business > event_or_party_service > party_and_event_planning', 'other'],
  ['community_and_government > social_or_community_service > community_center', 'other'],
  ['education > library', 'other'],
  ['education > place_of_learning > specialty_school > cooking_school', 'entertainment'],
  ['', 'other'],
];

const DROPPED: [string, string][] = [
  ['services_and_business > professional_service', 'office_b2b'],
  ['services_and_business > corporate_or_business_office > information_technology_company', 'office_b2b'],
  ['services_and_business > b2b_service > supplier_or_distributor > food_beverage_distributor', 'office_b2b'],
  ['services_and_business > media_service > media_news_company', 'office_b2b'],
  ['services_and_business > b2b_service > manufacturer > textile_manufacturer', 'industrial'],
  ['services_and_business > b2b_service > b2b_industrial_and_machine_service > chemical_plant', 'industrial'],
  ['services_and_business > storage_facility', 'industrial'],
  ['services_and_business > real_estate_service > real_estate_agent', 'real_estate'],
  ['services_and_business > real_estate_service > builder > home_developer', 'real_estate'],
  ['community_and_government > government_office', 'government'],
  ['community_and_government > government_office > town_hall', 'government'],
  ['community_and_government > public_safety_service > police_station', 'government'],
  ['community_and_government > military_site', 'government'],
  ['community_and_government > civic_organization > labor_union', 'government'],
  ['education > place_of_learning > school > elementary_school', 'education'],
  ['education > place_of_learning > school > preschool', 'education'],
  ['education > place_of_learning > college_university', 'education'],
  ['education > place_of_learning > specialty_school > language_school', 'education'],
  ['services_and_business > family_service > child_care_and_day_care > day_care_preschool', 'education'],
  ['services_and_business > housing_or_property_service > condominium', 'housing'],
  ['travel_and_transportation > vehicle_service > automotive_service > automotive_repair', 'vehicle'],
  ['travel_and_transportation > vehicle_service > motorcycle_service > motorcycle_repair', 'vehicle'],
  ['shopping > vehicle_dealer > auto_dealer', 'vehicle'],
  ['shopping > specialty_store > vehicle_parts_store > auto_parts_store', 'vehicle'],
  ['shopping > specialty_store > hardware_home_and_garden_store > building_supply_store', 'construction'],
  ['shopping > specialty_store > hardware_home_and_garden_store > furniture_store', 'construction'],
  ['shopping > specialty_store > hardware_home_and_garden_store', 'construction'],
  ['services_and_business > building_or_construction_service', 'construction'],
  ['services_and_business > legal_service > attorney_or_law_firm', 'legal_finance'],
  ['services_and_business > financial_service > insurance_agency', 'legal_finance'],
  ['services_and_business > financial_service > accountant', 'legal_finance'],
  ['shopping > second_hand_store > pawn_shop', 'legal_finance'],
  ['services_and_business > professional_service > employment_agency', 'recruitment'],
  ['services_and_business > b2b_service > b2b_transportation_and_storage_service > freight_and_cargo_service', 'logistics'],
  ['services_and_business > shipping_or_delivery_service > shipping_center', 'logistics'],
  ['services_and_business > printing_service', 'printing_ads'],
  ['services_and_business > professional_service > advertising_agency', 'printing_ads'],
  ['services_and_business > home_service > home_cleaning', 'cleaning_technical'],
  ['services_and_business > technical_service > it_service_and_computer_repair', 'cleaning_technical'],
  ['services_and_business > financial_service > bank_or_credit_union > bank', 'bank_branch'],
];

describe('Overture category rules (O2)', () => {
  it.each(KEPT)('keeps %s as %s', (category, code) => {
    expect(keep(category)).toMatchObject({ action: 'keep', code });
  });
  it.each(DROPPED)('drops %s (%s)', (category, reason) => {
    expect(keep(category)).toMatchObject({ action: 'exclude', reason });
  });
  it('covers at least 40 sample categories', () => {
    expect(KEPT.length + DROPPED.length).toBeGreaterThanOrEqual(40);
  });
  it('only targets real taxonomy codes, each in a search group', () => {
    for (const code of [...Object.values(KEEP), ...Object.values(MAP)] as string[]) {
      expect(isPoiCategory(code), code).toBe(true);
      expect(poiCategoryGroup(code), code).not.toBeNull();
    }
    for (const [label, rules] of Object.values(EXCLUDE) as [string, string[]][]) {
      expect(label).not.toBe('');
      expect(rules.length).toBeGreaterThan(0);
    }
  });
  it('unknown kept categories fall back to other, never dropped', () => {
    expect(classifyCategory('brand_new_root>something')).toEqual({ action: 'keep', code: 'other', rule: null });
  });
  it('exact rules ($) do not cover children', () => {
    expect(keep('shopping > specialty_store > hardware_home_and_garden_store > nursery_and_gardening_store')).toMatchObject({
      action: 'keep',
      code: 'shopping',
    });
  });
  it('maps activity types onto the shared list', () => {
    for (const type of Object.values(ACTIVITY_TYPE)) expect(POI_ACTIVITY_TYPES).toContain(type);
    expect(activityTypeFor('beach')).toBe('BEACH');
    expect(activityTypeFor('restaurant')).toBe('FOOD');
    expect(activityTypeFor('shopping')).toBe('SHOPPING');
    expect(activityTypeFor('other')).toBeNull();
    expect(activityTypeFor('traveler_service')).toBeNull();
  });
});

describe('Overture record filters', () => {
  it('folds Vietnamese text', () => {
    expect(foldText('  Chợ Hàn – Đà Nẵng ')).toBe('cho han da nang');
  });
  it('rejects names that are empty, numeric or just an address', () => {
    expect(isUnusableName('', null)).toBe(true);
    expect(isUnusableName('12345', null)).toBe(true);
    expect(isUnusableName('Số 5 Lê Lợi', null)).toBe(true);
    expect(isUnusableName('Hẻm 45 Trần Phú', null)).toBe(true);
    expect(isUnusableName('123 Nguyễn Huệ', '123 Nguyễn Huệ, Quận 1')).toBe(true);
    expect(isUnusableName('35 Phan Bội Châu', '35 Phan Bội Châu')).toBe(true);
  });
  it('keeps real names, including ones that start with a number', () => {
    expect(isUnusableName('Chợ Hàn', '119 Trần Phú')).toBe(false);
    expect(isUnusableName('1985 Cafe', '12 Lê Lợi')).toBe(false);
    expect(isUnusableName('Phở 24', null)).toBe(false);
    expect(isUnusableName('北京饭店', null)).toBe(false);
  });
});
