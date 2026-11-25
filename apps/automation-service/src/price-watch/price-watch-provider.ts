import { Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { NormalizedPriceQuery } from './price-watch.domain';
import { PriceProviderFailure, type PriceProviderResult } from './price-watch-worker.domain';

export interface PriceProviderRequest {
  canonicalKey: string;
  scheduledSlot: string;
  query: NormalizedPriceQuery;
  signal: AbortSignal;
}

export function configuredFlightProvider(config: ConfigService): string | undefined {
  const selected = config.get<string>('PRICE_WATCH_PROVIDER')?.trim();
  if (selected) return selected;
  // Production deployments require an explicit provider before the worker can start.
  if (config.get<string>('NODE_ENV') === 'production') return undefined;
  return config.get<string>('TRAVELPAYOUTS_TOKEN')?.trim() ? 'TRAVELPAYOUTS_CACHE' : 'MOCK_FLIGHT';
}

@Injectable()
export class MockFlightPriceProvider {
  async fetch(request: PriceProviderRequest): Promise<PriceProviderResult> {
    if (request.signal.aborted) throw new PriceProviderFailure('PROVIDER_TIMEOUT', true);
    if (request.query.provider !== 'MOCK_FLIGHT')
      throw new PriceProviderFailure('PROVIDER_NOT_SUPPORTED', false);
    const digest = createHash('sha256')
      .update(`${request.canonicalKey}:${request.scheduledSlot}`, 'utf8')
      .digest();
    const raw = digest.readUInt32BE(0);
    const price = 800_000 + (raw % 220) * 10_000;
    const fareId = createHash('sha256')
      .update(`fare:${request.canonicalKey}:${request.scheduledSlot}`, 'utf8')
      .digest('hex')
      .slice(0, 20);
    return {
      kind: 'SUCCESS',
      price: String(price),
      currency: 'VND',
      provider: 'MOCK_FLIGHT',
      fare_metadata: {
        provider_fare_id: `mock-${fareId}`,
        carrier_code: 'WF',
        fare_class: request.query.cabin_class ?? null,
        baggage_summary: 'MOCK_DATA',
      },
    };
  }
}
