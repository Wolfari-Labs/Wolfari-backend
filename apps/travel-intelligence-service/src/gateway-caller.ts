import type { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';

/** Travel RPCs are reachable only from the API Gateway holding GATEWAY_TRAVEL_SECRET. */
export function assertGatewayCaller(config: ConfigService, metadata: Metadata | undefined): void {
  const expected = Buffer.from(config.get<string>('GATEWAY_TRAVEL_SECRET') ?? '');
  const provided = Buffer.from(String(metadata?.get('x-service-secret')[0] ?? ''));
  if (
    metadata?.get('x-caller-service')[0] !== 'ApiGateway' ||
    expected.length < 32 ||
    provided.length !== expected.length ||
    !timingSafeEqual(expected, provided)
  )
    throw new RpcException({
      code: status.PERMISSION_DENIED,
      message: 'Caller is not authorized',
    });
}
