import type { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';

/** Which caller holds which shared secret (paired by `pnpm env:init`). */
const CREDENTIALS = { ApiGateway: 'GATEWAY_TRAVEL_SECRET', Trip: 'TRIP_TRAVEL_SECRET' } as const;
export type TravelCaller = keyof typeof CREDENTIALS;

/** Accepts only the listed callers, each proving its own secret (≥ 32 bytes, constant-time). */
export function assertCaller(
  config: ConfigService,
  metadata: Metadata | undefined,
  allowed: readonly TravelCaller[],
): TravelCaller {
  const caller = String(metadata?.get('x-caller-service')[0] ?? '') as TravelCaller;
  const expected = Buffer.from(
    allowed.includes(caller) ? (config.get<string>(CREDENTIALS[caller]) ?? '') : '',
  );
  const provided = Buffer.from(String(metadata?.get('x-service-secret')[0] ?? ''));
  if (
    expected.length < 32 ||
    provided.length !== expected.length ||
    !timingSafeEqual(expected, provided)
  )
    throw new RpcException({
      code: status.PERMISSION_DENIED,
      message: 'Caller is not authorized',
    });
  return caller;
}

/** Travel RPCs are reachable only from the API Gateway holding GATEWAY_TRAVEL_SECRET. */
export function assertGatewayCaller(config: ConfigService, metadata: Metadata | undefined): void {
  assertCaller(config, metadata, ['ApiGateway']);
}
