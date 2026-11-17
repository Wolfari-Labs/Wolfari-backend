import type { IncomingMessage, ServerResponse } from 'node:http';
import { AutomationClient } from '@wolfari/contracts/automation-client';
import { TripClient } from './trip-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  idempotencyKey,
  isLoopbackGrpcTarget,
  json,
  onlyKeys,
  record,
  requestBody,
  RequestError,
  responseRecord,
  uuid,
  type SessionValidator,
} from './trip-http';

export function tripToolsRoute(method: string, path: string) {
  const match =
    /^\/api\/v1\/trips\/([^/]+)(?:\/(archive|reopen|ownership|plan\.pdf|reminders)(?:\/([^/]+))?)?$/.exec(
      path,
    );
  if (!match) return null;
  const [, tripId, tool, itemId] = match;
  const kind =
    !tool && method === 'DELETE'
      ? 'DELETE'
      : !itemId && method === 'POST' && tool === 'archive'
        ? 'ARCHIVE'
        : !itemId && method === 'POST' && tool === 'reopen'
          ? 'REOPEN'
          : !itemId && method === 'POST' && tool === 'ownership'
            ? 'TRANSFER'
            : !itemId && method === 'GET' && tool === 'plan.pdf'
              ? 'PDF'
              : tool === 'reminders'
                ? !itemId && method === 'GET'
                  ? 'LIST'
                  : !itemId && method === 'POST'
                    ? 'CREATE'
                    : itemId && method === 'DELETE'
                      ? 'CANCEL'
                      : null
                : null;
  if (!kind) return null;
  if (!uuid.test(tripId!) || (itemId && !uuid.test(itemId))) throw new RequestError('Invalid ID');
  return { kind, tripId: tripId!.toLowerCase(), itemId: itemId?.toLowerCase() };
}
export class TripToolsProxy {
  private readonly trip: TripClient;
  private readonly automation?: AutomationClient;
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202',
      secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw Error('Trip tools transport invalid');
    this.trip = new TripClient(target, secret);
    const automation = process.env.AUTOMATION_GRPC_TARGET,
      token = process.env.GATEWAY_AUTOMATION_SECRET ?? '';
    if (automation && isLoopbackGrpcTarget(automation) && token.length >= 32)
      this.automation = new AutomationClient(automation, token);
  }
  matches(request: IncomingMessage & { originalUrl?: string }) {
    const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
    return (
      /^\/api\/v1\/trips\/[^/]+\/(archive|reopen|ownership|plan\.pdf|reminders)(?:\/|$)/.test(
        path,
      ) ||
      (request.method === 'DELETE' && /^\/api\/v1\/trips\/[^/]+$/.test(path))
    );
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost'),
        route = tripToolsRoute(request.method ?? '', url.pathname);
      if (!route) return fail(response, 404, 'RESOURCE_NOT_FOUND');
      const write = !['PDF', 'LIST'].includes(route.kind),
        auth = await authenticate(request, response, this.validateSession, write);
      if (!auth) return;
      ensureQuery(url, []);
      const base = { trip_id: route.tripId, actor_user_id: auth.actorUserId };
      if (route.kind === 'PDF') {
        const result = await this.trip.call('ExportPlanPdf', base, auth.correlationId);
        if (
          !Buffer.isBuffer(result.content) ||
          result.content.length > 10 * 1024 * 1024 ||
          !result.content.subarray(0, 5).equals(Buffer.from('%PDF-'))
        )
          throw Error('Invalid PDF');
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': result.content.length,
          'Content-Disposition': `attachment; filename="wolfari-plan-${route.tripId}.pdf"`,
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(result.content);
        return;
      }
      if (
        (!write || route.kind === 'CANCEL') &&
        (request.headers['transfer-encoding'] ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0'))
      )
        throw new RequestError('Unexpected body');
      const body = write && route.kind !== 'CANCEL' ? record(await requestBody(request)) : {};
      let result: Record<string, unknown>;
      if (['LIST', 'CREATE', 'CANCEL'].includes(route.kind)) {
        if (!this.automation) return fail(response, 503, 'SERVICE_UNAVAILABLE');
        onlyKeys(body, route.kind === 'CREATE' ? ['source_type', 'source_id', 'remind_at'] : []);
        result = await this.automation.call(
          route.kind === 'LIST'
            ? 'ListReminders'
            : route.kind === 'CREATE'
              ? 'CreateReminder'
              : 'CancelReminder',
          {
            ...base,
            ...body,
            ...(route.itemId ? { reminder_id: route.itemId } : {}),
            ...(route.kind === 'CREATE' ? { operation_id: idempotencyKey(request, true) } : {}),
          },
          auth.correlationId,
        );
      } else {
        onlyKeys(body, [
          'reason',
          'expected_plan_version',
          'expected_membership_revision',
          'expected_export_revision',
          ...(route.kind === 'TRANSFER' ? ['new_owner_member_id'] : []),
        ]);
        if (
          typeof body.reason !== 'string' ||
          !body.reason.trim() ||
          [...body.reason].length > 1000 ||
          body.reason.includes('\0')
        )
          throw new RequestError('Invalid reason');
        for (const key of [
          'expected_plan_version',
          'expected_membership_revision',
          'expected_export_revision',
        ])
          if (
            !Number.isInteger(body[key]) ||
            Number(body[key]) < 1 ||
            Number(body[key]) > 2147483647
          )
            throw new RequestError('Invalid revision');
        if (
          route.kind === 'TRANSFER' &&
          (typeof body.new_owner_member_id !== 'string' || !uuid.test(body.new_owner_member_id))
        )
          throw new RequestError('Invalid new Owner');
        result = await this.trip.call(
          'ManageTrip',
          { ...base, ...body, action: route.kind, operation_id: idempotencyKey(request, true) },
          auth.correlationId,
        );
      }
      if (typeof result.result_json !== 'string') throw Error('Invalid tool response');
      const data = JSON.parse(result.result_json);
      if (!data || typeof data !== 'object') throw Error('Invalid tool projection');
      if (!Array.isArray(data)) responseRecord(data);
      json(response, route.kind === 'CREATE' ? 201 : 200, {
        data,
        meta: { correlation_id: auth.correlationId },
      });
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, request.method !== 'GET');
    }
  }
  close() {
    this.trip.close();
    this.automation?.close();
  }
}
