import type { ConfigService } from '@nestjs/config';
import { status, type Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { RPC_CATALOG, TripV1 } from '@wolfari/contracts/grpc';
import { timingSafeEqual } from 'node:crypto';
import { TripError } from './trip.errors';

const callerCredentials: Record<string, string> = {
  ApiGateway: 'GATEWAY_TRIP_SECRET',
  Finance: 'FINANCE_TRIP_SECRET',
  Travel: 'TRAVEL_TRIP_SECRET',
  Automation: 'AUTOMATION_TRIP_SECRET',
};

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

export function authorizeTripCall(
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
  const credential = callerCredentials[caller];
  const expected = credential ? (config.get<string>(credential) ?? '') : '';
  const providedBytes = Buffer.from(secret);
  const expectedBytes = Buffer.from(expected);
  const validSecret =
    expectedBytes.length >= 32 &&
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes);
  if (!entry?.callers.includes(caller) || !validSecret || !CORRELATION_ID.test(correlationId)) {
    throw new RpcException({
      code: status.PERMISSION_DENIED,
      message: 'Caller is not authorized',
    });
  }
  return correlationId.toLowerCase();
}

export function tripGrpcStatus(error: TripError): status {
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return status.INVALID_ARGUMENT;
    case 'RESOURCE_NOT_FOUND':
      return status.NOT_FOUND;
    case 'PERMISSION_DENIED':
      return status.PERMISSION_DENIED;
    case 'IDEMPOTENCY_CONFLICT':
      return status.ALREADY_EXISTS;
    case 'STATE_CONFLICT':
      return status.FAILED_PRECONDITION;
    case 'VERSION_CONFLICT':
      return status.ABORTED;
  }
}

export async function executeTripCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TripError) {
      throw new RpcException({
        code: tripGrpcStatus(error),
        message: JSON.stringify({ code: error.code, details: error.details }),
      });
    }
    throw new RpcException({
      code: status.UNAVAILABLE,
      message: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', details: null }),
    });
  }
}
