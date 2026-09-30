import type { ConfigService } from '@nestjs/config';
import { status, type Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { RPC_CATALOG, TripV1 } from '@wolfari/contracts/grpc';
import { timingSafeEqual } from 'node:crypto';
import { TripError } from './trip-common';

export const CORRELATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function timestamp(value: { seconds?: string; nanos?: number } | undefined): Date {
  if (
    !value ||
    typeof value.seconds !== 'string' ||
    !/^-?\d+$/.test(value.seconds) ||
    !Number.isInteger(value.nanos) ||
    Number(value.nanos) < 0 ||
    Number(value.nanos) > 999_999_999
  ) {
    throw new TripError('VALIDATION_FAILED', 400);
  }
  const seconds = Number(value.seconds);
  const milliseconds = seconds * 1000 + Math.floor(Number(value.nanos) / 1_000_000);
  const result = new Date(milliseconds);
  if (!Number.isSafeInteger(seconds) || Number.isNaN(result.getTime())) {
    throw new TripError('VALIDATION_FAILED', 400);
  }
  return result;
}

export function protobufTimestamp(value: string): { seconds: string; nanos: number } {
  const milliseconds = new Date(value).getTime();
  return {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: (((milliseconds % 1000) + 1000) % 1000) * 1_000_000,
  };
}

export function patchValue(value: TripV1.StringPatch): string | null {
  const hasValue = value.value !== undefined;
  const hasClear = value.clear !== undefined;
  if (hasValue === hasClear || (hasClear && value.clear !== true)) {
    throw new TripError('VALIDATION_FAILED', 400);
  }
  return hasValue ? value.value! : null;
}

export function authorizeGatewayCall(
  config: ConfigService,
  method: string,
  metadata?: Metadata,
): string {
  const caller = String(metadata?.get('x-caller-service')[0] ?? '');
  const secret = String(metadata?.get('x-service-secret')[0] ?? '');
  const correlationId = String(metadata?.get('x-correlation-id')[0] ?? '');
  const entry = RPC_CATALOG.find(
    (value) =>
      value.package === 'wolfari.trip.v1' &&
      value.service === 'TripService' &&
      value.method === method,
  );
  const expected = config.get<string>('GATEWAY_TRIP_SECRET') ?? '';
  const providedBytes = Buffer.from(secret);
  const expectedBytes = Buffer.from(expected);
  const validSecret =
    expectedBytes.length >= 32 &&
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes);
  if (
    caller !== 'ApiGateway' ||
    !entry?.callers.includes(caller) ||
    !validSecret ||
    !CORRELATION_ID.test(correlationId)
  ) {
    throw new RpcException({
      code: status.PERMISSION_DENIED,
      message: 'Caller is not authorized',
    });
  }
  return correlationId.toLowerCase();
}

export async function executeTripCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TripError) {
      const code =
        error.code === 'VALIDATION_FAILED'
          ? status.INVALID_ARGUMENT
          : error.code === 'RESOURCE_NOT_FOUND'
            ? status.NOT_FOUND
            : error.code === 'PERMISSION_DENIED'
              ? status.PERMISSION_DENIED
              : error.code === 'IDEMPOTENCY_CONFLICT'
                ? status.ALREADY_EXISTS
                : error.code === 'STATE_CONFLICT'
                  ? status.FAILED_PRECONDITION
                  : status.ABORTED;
      throw new RpcException({
        code,
        message: JSON.stringify({ code: error.code, details: error.details }),
      });
    }
    throw new RpcException({
      code: status.UNAVAILABLE,
      message: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', details: null }),
    });
  }
}
