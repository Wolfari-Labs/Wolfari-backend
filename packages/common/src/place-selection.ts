import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sources whose search results may be saved through a signed selection token. */
export const PLACE_SELECTION_PROVIDERS = Object.freeze(['GEOAPIFY', 'WOLFARI'] as const);
export type PlaceSelectionProvider = (typeof PLACE_SELECTION_PROVIDERS)[number];
export interface PlaceSnapshot {
  /** WOLFARI: provider_place_id is the curated POI wolfari_key. */
  provider: PlaceSelectionProvider;
  provider_place_id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  categories: string[];
  fetched_at: string;
  attribution: string;
}
export interface PlaceSelection {
  actor: string;
  trip: string;
  expires: number;
  place: PlaceSnapshot;
}
export function signPlaceSelection(value: PlaceSelection, secret: string): string {
  if (secret.length < 32) throw new Error('PLACE_SELECTION_SECRET missing');
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
/** Expiry is checked after an idempotency receipt lookup by the Trip write. */
export function readPlaceSelection(
  token: string,
  secret: string,
  actor: string,
  trip: string,
): PlaceSelection {
  if (secret.length < 32 || token.length > 16000) throw new Error('INVALID_SELECTION');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('INVALID_SELECTION');
  const expected = createHmac('sha256', secret).update(parts[0]!).digest();
  const actual = Buffer.from(parts[1]!, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('INVALID_SELECTION');
  const value = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as PlaceSelection;
  if (
    value.actor !== actor ||
    value.trip !== trip ||
    !Number.isFinite(value.expires) ||
    !(PLACE_SELECTION_PROVIDERS as readonly unknown[]).includes(value.place?.provider)
  )
    throw new Error('INVALID_SELECTION');
  return value;
}
