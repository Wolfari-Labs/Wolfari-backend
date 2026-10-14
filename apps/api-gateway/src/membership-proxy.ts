import type { IncomingMessage, ServerResponse } from 'node:http';
import { TripClient } from './trip-client';
import {
  authenticate,
  type SessionValidator,
  RequestError,
  ensureQuery,
  requestBody,
  onlyKeys,
  idempotencyKey,
  uuid,
  json,
  fail,
  grpcFailure,
  responseRecord,
  requiredString,
  enumValue,
  timestampToIso,
  isLoopbackGrpcTarget,
} from './trip-http';
import { projectMembership } from './trip-proxy';

const states = {
  1: 'PROCESSING',
  2: 'PENDING_RECOVERY',
  3: 'SUCCEEDED',
  4: 'FAILED',
  5: 'NEEDS_REVIEW',
};
export function projectOperation(value: unknown) {
  const row = responseRecord(value);
  const error = (value: unknown) => {
    if (value === undefined) return undefined;
    if (
      !['FINANCE_OBLIGATION_BLOCKED', 'STATE_CONFLICT', 'VERSION_CONFLICT'].includes(String(value))
    )
      throw new Error('Invalid operation error');
    return String(value);
  };
  const outcome = row.outcome === undefined ? undefined : responseRecord(row.outcome);
  return {
    operation_id: requiredString(row.operation_id),
    trip_id: requiredString(row.trip_id),
    state: enumValue(row.state, states),
    ...(outcome
      ? {
          outcome: {
            status: enumValue(outcome.status, { 1: 'COMMITTED', 2: 'REJECTED', 3: 'CANCELLED' }),
            ...(outcome.error_code ? { error_code: error(outcome.error_code) } : {}),
          },
        }
      : {}),
    ...(row.error_code ? { error_code: error(row.error_code) } : {}),
    ...(row.next_retry_at ? { next_retry_at: timestampToIso(row.next_retry_at) } : {}),
  };
}
type Request = IncomingMessage & { originalUrl?: string };
export class MembershipProxy {
  private readonly client: TripClient;
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202';
    const secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (
      !isLoopbackGrpcTarget(target) ||
      secret.length < 32 ||
      process.env.NODE_ENV === 'production'
    )
      throw new Error('Invalid membership transport configuration');
    this.client = new TripClient(target, secret);
  }
  matches(request: Request) {
    const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
    return (
      /^\/api\/v1\/trips\/[^/]+\/(members|leave)(?:\/|$)/.test(path) ||
      path.startsWith('/api/v1/operations/')
    );
  }
  async handle(request: Request, response: ServerResponse) {
    const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
    const members = /^\/api\/v1\/trips\/([^/]+)\/members(?:\/([^/]+))?$/.exec(url.pathname);
    const leave = /^\/api\/v1\/trips\/([^/]+)\/leave$/.exec(url.pathname);
    const poll = /^\/api\/v1\/operations\/([^/]+)$/.exec(url.pathname);
    const listing = members && !members[2] && request.method === 'GET';
    const removing = members?.[2] && request.method === 'DELETE';
    const leaving = leave && request.method === 'POST';
    if (!listing && !removing && !leaving && !(poll && request.method === 'GET'))
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const write = Boolean(removing || leaving);
    const auth = await authenticate(request, response, this.validateSession, write);
    if (!auth) return;
    try {
      const id = poll?.[1] ?? members?.[1] ?? leave?.[1];
      if (!id || !uuid.test(id) || (removing && !uuid.test(members![2]!)))
        throw new RequestError('Invalid ID');
      ensureQuery(url, listing ? ['limit', 'cursor', 'include_left'] : []);
      let data: unknown;
      let code = 200;
      if (poll) {
        const result = await this.client.call(
          'GetOperationResult',
          { operation_id: id, actor_user_id: auth.actorUserId },
          auth.correlationId,
        );
        data = projectOperation(result.operation);
      } else if (listing) {
        const rawLimit = url.searchParams.get('limit') ?? '20',
          left = url.searchParams.get('include_left') ?? 'false';
        if (
          !/^\d+$/.test(rawLimit) ||
          +rawLimit < 1 ||
          +rawLimit > 100 ||
          !['true', 'false'].includes(left)
        )
          throw new RequestError('Invalid pagination');
        const result = await this.client.call(
          'ListMembers',
          {
            actor_user_id: auth.actorUserId,
            trip_id: id,
            limit: +rawLimit,
            include_left: left === 'true',
            cursor: url.searchParams.get('cursor') ?? undefined,
          },
          auth.correlationId,
        );
        if (result.items !== undefined && !Array.isArray(result.items))
          throw new Error('Invalid membership list');
        data = {
          items: ((result.items ?? []) as unknown[]).map(projectMembership),
          next_cursor: result.next_cursor ?? null,
        };
      } else {
        const body = await requestBody(request);
        onlyKeys(body, ['reason', 'expected_membership_revision']);
        if (
          typeof body.reason !== 'string' ||
          !body.reason.trim() ||
          body.reason.trim().length > 1000 ||
          !Number.isInteger(body.expected_membership_revision) ||
          Number(body.expected_membership_revision) < 1 ||
          Number(body.expected_membership_revision) > 2147483647
        )
          throw new RequestError('Invalid lifecycle command');
        const result = await this.client.call(
          removing ? 'RemoveMember' : 'LeaveTrip',
          {
            ...body,
            actor_user_id: auth.actorUserId,
            trip_id: id,
            operation_id: idempotencyKey(request, true),
            ...(removing ? { member_id: members![2] } : {}),
          },
          auth.correlationId,
        );
        const operation = projectOperation(result.operation);
        data = operation;
        if (['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(operation.state))
          code = 202;
      }
      return json(response, code, { data, meta: { correlation_id: auth.correlationId } });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, write);
    }
  }
  close() {
    this.client.close();
  }
}
