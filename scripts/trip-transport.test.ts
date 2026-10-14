import { describe, expect, it } from 'vitest';
import { authorizeTripCall, executeTripCall } from '../apps/trip-workspace-service/src/grpc-common';
import { fail as failPlan } from '../apps/trip-workspace-service/src/trip-common';
import { fail as failAccess } from '../apps/trip-workspace-service/src/trip.errors';
import { domainFailure } from '../apps/api-gateway/src/trip-http';

const correlationId = '50000000-0000-4000-8000-000000000001';
const secrets: Record<string, string> = {
  GATEWAY_TRIP_SECRET: 'g'.repeat(64),
  FINANCE_TRIP_SECRET: 'f'.repeat(64),
  TRAVEL_TRIP_SECRET: 't'.repeat(64),
  AUTOMATION_TRIP_SECRET: 'a'.repeat(64),
};
const config = {
  get: (key: string) => secrets[key],
} as Parameters<typeof authorizeTripCall>[0];

function metadata(caller: string, secret: string, correlation = correlationId) {
  const values: Record<string, string> = {
    'x-caller-service': caller,
    'x-service-secret': secret,
    'x-correlation-id': correlation,
  };
  return { get: (key: string) => [values[key]] } as Parameters<typeof authorizeTripCall>[2];
}

describe('merged Trip, Planning and Invitations transport', () => {
  it.each([
    'GetPlan',
    'CreateActivity',
    'SetActivityCompletion',
    'UpdatePlanPolicy',
    'CreateInvitation',
    'AcceptInvitation',
  ])('allows Gateway to call %s with its own secret', (method) => {
    expect(
      authorizeTripCall(config, method, metadata('ApiGateway', secrets.GATEWAY_TRIP_SECRET)),
    ).toBe(correlationId);
  });

  it.each([
    ['Finance', 'FINANCE_TRIP_SECRET'],
    ['Travel', 'TRAVEL_TRIP_SECRET'],
    ['Automation', 'AUTOMATION_TRIP_SECRET'],
  ])('allows %s to read access context only with its own secret', (caller, key) => {
    expect(authorizeTripCall(config, 'GetAccessContext', metadata(caller, secrets[key]))).toBe(
      correlationId,
    );
    expect(() =>
      authorizeTripCall(config, 'GetAccessContext', metadata(caller, secrets.GATEWAY_TRIP_SECRET)),
    ).toThrow('Caller is not authorized');
  });

  it.each([
    ['ApiGateway', 'GetAccessContext', 'GATEWAY_TRIP_SECRET'],
    ['Travel', 'GetPlan', 'TRAVEL_TRIP_SECRET'],
    ['Finance', 'UpdatePlanPolicy', 'FINANCE_TRIP_SECRET'],
    ['Finance', 'CreateInvitation', 'FINANCE_TRIP_SECRET'],
    ['ApiGateway', 'GetInvitationDelivery', 'GATEWAY_TRIP_SECRET'],
  ])('rejects %s calling %s outside the catalog', (caller, method, key) => {
    expect(() => authorizeTripCall(config, method, metadata(caller, secrets[key]))).toThrow(
      'Caller is not authorized',
    );
  });

  it('rejects invalid correlation IDs before dispatching a Planning request', () => {
    expect(() =>
      authorizeTripCall(
        config,
        'GetPlan',
        metadata('ApiGateway', secrets.GATEWAY_TRIP_SECRET, 'invalid'),
      ),
    ).toThrow('Caller is not authorized');
  });

  it.each([
    ['Planning', failPlan, { plan_version: 4, export_revision: 7 }],
    ['Plan access', failAccess, { membership_revision: 3 }],
    ['Invitations', failAccess, { invitation_version: 2 }],
  ] as const)(
    'preserves %s conflicts through shared gRPC and HTTP translation',
    async (_, fail, details) => {
      const error = await executeTripCall(async () => fail('VERSION_CONFLICT', 409, details)).catch(
        (cause: { getError(): { code: number; message: string } }) => cause.getError(),
      );
      expect(error.code).toBe(10);
      expect(domainFailure({ details: error.message })).toEqual({
        code: 'VERSION_CONFLICT',
        details,
      });
    },
  );
});
