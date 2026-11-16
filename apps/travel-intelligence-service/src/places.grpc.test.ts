import { expect, it, vi } from 'vitest';
import { Metadata } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import { PlacesController } from './places.grpc';
import type { PlacesService } from './places.service';
it('Travel rejects missing/wrong service authentication before any provider call', async () => {
  const search = vi.fn(async () => ({ data: [] }));
  const controller = new PlacesController(
    { search } as unknown as PlacesService,
    new ConfigService({ GATEWAY_TRAVEL_SECRET: 's'.repeat(64) }),
  );
  const request = { query: '' };
  for (const [caller, secret] of [
    ['ApiGateway', 'wrong'],
    ['Other', 's'.repeat(64)],
    ['', ''],
  ]) {
    const metadata = new Metadata();
    metadata.set('x-caller-service', caller!);
    metadata.set('x-service-secret', secret!);
    await expect(controller.searchPlaces(request, metadata)).rejects.toThrow();
  }
  expect(search).not.toHaveBeenCalled();
  const metadata = new Metadata();
  metadata.set('x-caller-service', 'ApiGateway');
  metadata.set('x-service-secret', 's'.repeat(64));
  await expect(controller.searchPlaces(request, metadata)).resolves.toEqual({ data: [] });
  expect(search).toHaveBeenCalledTimes(1);
});
