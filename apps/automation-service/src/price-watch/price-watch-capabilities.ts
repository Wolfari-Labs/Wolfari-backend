/**
 * What each fare source can compare (SRS FR-AU03: the UI must not offer parameters the provider
 * does not support). Both real sources return published one-way economy fares for one adult in
 * VND; the development mock accepts every combination the domain allows. This table is the only
 * place that knows it: create/update validation and GET /price-watch-capabilities both use it.
 */
export type JourneyType = 'ONE_WAY' | 'ROUND_TRIP';
export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
export type ProviderCapabilities = Readonly<{
  journey_types: readonly JourneyType[];
  cabin_classes: readonly CabinClass[];
  max_adults: number;
  max_children: number;
  max_infants: number;
  max_passengers: number;
  currencies: readonly string[];
}>;

const REFERENCE_FARES: ProviderCapabilities = Object.freeze({
  journey_types: Object.freeze(['ONE_WAY'] as const),
  cabin_classes: Object.freeze(['ECONOMY'] as const),
  max_adults: 1,
  max_children: 0,
  max_infants: 0,
  max_passengers: 1,
  currencies: Object.freeze(['VND']),
});
const EVERYTHING: ProviderCapabilities = Object.freeze({
  journey_types: Object.freeze(['ONE_WAY', 'ROUND_TRIP'] as const),
  cabin_classes: Object.freeze(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const),
  max_adults: 9,
  max_children: 9,
  max_infants: 9,
  max_passengers: 9,
  currencies: Object.freeze(['VND']),
});

export function providerCapabilities(provider: string): ProviderCapabilities {
  return provider === 'MOCK_FLIGHT' ? EVERYTHING : REFERENCE_FARES;
}

export function supportsQuery(
  capabilities: ProviderCapabilities,
  query: Readonly<{
    journey_type: JourneyType;
    cabin_class: string;
    adults: number;
    children: number;
    infants: number;
    currency: string;
  }>,
): boolean {
  return (
    capabilities.journey_types.includes(query.journey_type) &&
    (capabilities.cabin_classes as readonly string[]).includes(query.cabin_class) &&
    query.adults <= capabilities.max_adults &&
    query.children <= capabilities.max_children &&
    query.infants <= capabilities.max_infants &&
    query.adults + query.children + query.infants <= capabilities.max_passengers &&
    capabilities.currencies.includes(query.currency)
  );
}
