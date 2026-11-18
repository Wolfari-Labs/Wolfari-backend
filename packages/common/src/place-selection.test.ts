import { describe, it, expect } from 'vitest';
import { signPlaceSelection, readPlaceSelection, type PlaceSelection } from './place-selection';
const secret = 'x'.repeat(64);
const selection: PlaceSelection = {
  actor: 'actor',
  trip: 'trip',
  expires: 1,
  place: {
    provider: 'GEOAPIFY',
    provider_place_id: 'long-id',
    name: 'Hoi An',
    address: 'VN',
    latitude: 16,
    longitude: 108,
    categories: [],
    fetched_at: '2026-11-12T00:00:00Z',
    attribution: 'Geoapify',
  },
};
describe('signed provider selection', () => {
  it('preserves expired snapshot so receipt replay can precede expiry validation', () =>
    expect(
      readPlaceSelection(signPlaceSelection(selection, secret), secret, 'actor', 'trip'),
    ).toEqual(selection));
  it.each(['actor', 'trip', 'key', 'body'])('rejects changed %s', (kind) => {
    const token = signPlaceSelection(selection, secret);
    expect(() =>
      readPlaceSelection(
        kind === 'body' ? token.replace(token[4]!, token[4] === 'a' ? 'b' : 'a') : token,
        kind === 'key' ? 'y'.repeat(64) : secret,
        kind === 'actor' ? 'other' : 'actor',
        kind === 'trip' ? 'other' : 'trip',
      ),
    ).toThrow();
  });
  it('refuses missing signing secret', () =>
    expect(() => signPlaceSelection(selection, '')).toThrow());
});
describe('WOLFARI curated selection', () => {
  const wolfari: PlaceSelection = {
    ...selection,
    place: {
      ...selection.place,
      provider: 'WOLFARI',
      provider_place_id: 'dn-cho-han',
      name: 'Chợ Hàn',
      categories: ['market'],
      attribution: '© OpenStreetMap contributors',
    },
  };
  it('accepts a signed WOLFARI token keyed by wolfari_key', () =>
    expect(
      readPlaceSelection(signPlaceSelection(wolfari, secret), secret, 'actor', 'trip'),
    ).toEqual(wolfari));
  it.each(['GOOGLE', 'wolfari', '', undefined])(
    'rejects signed token for provider %s',
    (provider) => {
      const forged = {
        ...wolfari,
        place: { ...wolfari.place, provider },
      } as unknown as PlaceSelection;
      expect(() =>
        readPlaceSelection(signPlaceSelection(forged, secret), secret, 'actor', 'trip'),
      ).toThrow('INVALID_SELECTION');
    },
  );
});
