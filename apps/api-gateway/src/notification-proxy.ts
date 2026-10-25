import type { IncomingMessage, ServerResponse } from 'node:http';
import { AutomationClient } from '@wolfari/contracts/automation-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  isLoopbackGrpcTarget,
  json,
  onlyKeys,
  optionalString,
  record,
  requestBody,
  RequestError,
  requiredInteger,
  requiredString,
  responseRecord,
  timestampToIso,
  uuid,
  type RpcMessage,
  type SessionValidator,
} from './trip-http';

type Route =
  | { kind: 'get-preferences' }
  | { kind: 'update-preferences' }
  | { kind: 'register-device' }
  | { kind: 'list-notifications' }
  | { kind: 'delete-device'; id: string }
  | { kind: 'mark-read'; id: string };

const groupValues: Record<string, number> = {
  INVITATION: 1,
  PLAN: 2,
  PACKING: 3,
  CONTRIBUTION: 4,
  CLOSURE: 5,
  PRICE: 6,
};
const groupNames: Record<number, string> = Object.fromEntries(
  Object.entries(groupValues).map(([key, value]) => [value, key]),
);
const platforms = { IOS: 1, ANDROID: 2, WEB: 3 } as const;
const platformNames: Record<number, string> = { 1: 'IOS', 2: 'ANDROID', 3: 'WEB' };
const statusNames: Record<number, string> = { 1: 'CREATED', 2: 'AVAILABLE', 3: 'CANCELLED' };

export function notificationRoute(method: string, path: string): Route | null {
  if (path === '/api/v1/me/notification-preferences') {
    if (method === 'GET') return { kind: 'get-preferences' };
    if (method === 'PUT') return { kind: 'update-preferences' };
    return null;
  }
  if (path === '/api/v1/me/devices') return method === 'POST' ? { kind: 'register-device' } : null;
  let match = /^\/api\/v1\/me\/devices\/([^/]+)$/.exec(path);
  if (match) {
    if (!uuid.test(match[1]!)) throw new RequestError('Invalid device id');
    return method === 'DELETE' ? { kind: 'delete-device', id: match[1]!.toLowerCase() } : null;
  }
  if (path === '/api/v1/me/notifications')
    return method === 'GET' ? { kind: 'list-notifications' } : null;
  match = /^\/api\/v1\/me\/notifications\/([^/]+)\/read$/.exec(path);
  if (match) {
    if (!uuid.test(match[1]!)) throw new RequestError('Invalid notification id');
    return method === 'PATCH' ? { kind: 'mark-read', id: match[1]!.toLowerCase() } : null;
  }
  return null;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new RequestError('Invalid boolean');
  return value;
}

function responseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid Automation response');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    throw new RequestError('Invalid integer');
  return Number(value);
}

function enumName(value: unknown, names: Record<number, string>): string {
  if (typeof value === 'string') {
    const found = Object.values(names).find((name) => value === name || value.endsWith(`_${name}`));
    if (found) return found;
  }
  const found = names[Number(value)];
  if (!found) throw new Error('Invalid Automation response');
  return found;
}

function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid Automation response');
  return value;
}

export function preferenceInput(body: RpcMessage): RpcMessage {
  onlyKeys(body, ['push_enabled', 'email_enabled', 'group_overrides', 'expected_version']);
  const groups = record(body.group_overrides);
  onlyKeys(groups, Object.keys(groupValues));
  const groupOverrides = Object.entries(groups).map(([group, raw]) => {
    const value = record(raw);
    onlyKeys(value, ['push', 'email']);
    if (!Object.hasOwn(value, 'push') && !Object.hasOwn(value, 'email'))
      throw new RequestError('Empty preference group');
    return {
      group: groupValues[group],
      ...(Object.hasOwn(value, 'push') ? { push: boolean(value.push) } : {}),
      ...(Object.hasOwn(value, 'email') ? { email: boolean(value.email) } : {}),
    };
  });
  return {
    push_enabled: boolean(body.push_enabled),
    email_enabled: boolean(body.email_enabled),
    group_overrides: groupOverrides,
    expected_version: integer(body.expected_version),
  };
}

export function deviceInput(body: RpcMessage): RpcMessage {
  onlyKeys(body, ['platform', 'token']);
  if (typeof body.platform !== 'string' || !Object.hasOwn(platforms, body.platform))
    throw new RequestError('Invalid platform');
  if (
    typeof body.token !== 'string' ||
    body.token.length < 16 ||
    body.token.length > 4096 ||
    body.token !== body.token.trim() ||
    !/^[\x21-\x7e]+$/.test(body.token)
  )
    throw new RequestError('Invalid token');
  return { platform: platforms[body.platform as keyof typeof platforms], token: body.token };
}

export function preferenceProjection(value: unknown) {
  const item = responseRecord(value);
  const groups: RpcMessage = {};
  for (const raw of list(item.group_overrides)) {
    const override = responseRecord(raw);
    const group = enumName(override.group, groupNames);
    const projected: RpcMessage = {};
    if (override.push !== undefined) projected.push = responseBoolean(override.push);
    if (override.email !== undefined) projected.email = responseBoolean(override.email);
    if (!Object.keys(projected).length || Object.hasOwn(groups, group))
      throw new Error('Invalid Automation response');
    groups[group] = projected;
  }
  return {
    push_enabled: responseBoolean(item.push_enabled),
    email_enabled: responseBoolean(item.email_enabled),
    group_overrides: groups,
    version: requiredInteger(item.version),
  };
}

export function deviceProjection(value: unknown) {
  const item = responseRecord(value);
  return {
    id: requiredString(item.id),
    platform: enumName(item.platform, platformNames),
    active: responseBoolean(item.active),
    last_seen_at: timestampToIso(item.last_seen_at),
  };
}

export function notificationProjection(value: unknown) {
  const item = responseRecord(value);
  return {
    id: requiredString(item.id),
    type: requiredString(item.type),
    title: requiredString(item.title),
    body: requiredString(item.body),
    trip_id: optionalString(item.trip_id),
    source_id: optionalString(item.source_id),
    status: enumName(item.status, statusNames),
    created_at: timestampToIso(item.created_at),
    read_at: item.read_at === undefined ? null : timestampToIso(item.read_at),
  };
}

function page(url: URL): { limit: number; cursor?: string; unread?: boolean } {
  ensureQuery(url, ['limit', 'cursor', 'unread']);
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError('Invalid limit');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > 1000))
    throw new RequestError('Invalid cursor');
  const rawUnread = url.searchParams.get('unread');
  if (rawUnread !== null && rawUnread !== 'true' && rawUnread !== 'false')
    throw new RequestError('Invalid unread filter');
  return {
    limit,
    ...(cursor ? { cursor } : {}),
    ...(rawUnread === null ? {} : { unread: rawUnread === 'true' }),
  };
}

function noBody(request: IncomingMessage & { body?: unknown }): void {
  const length = request.headers['content-length'];
  if (
    request.body !== undefined ||
    request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0')
  )
    throw new RequestError('Request body is not allowed');
}

export class NotificationProxy {
  private readonly client: AutomationClient;

  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.AUTOMATION_GRPC_TARGET ?? '127.0.0.1:3205';
    const secret = process.env.GATEWAY_AUTOMATION_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw new Error('Gateway Automation configuration invalid');
    if (process.env.NODE_ENV === 'production')
      throw new Error('Gateway Automation transport requires TLS in production');
    this.client = new AutomationClient(target, secret);
  }

  matches(request: IncomingMessage & { originalUrl?: string }): boolean {
    try {
      const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
      return /^\/api\/v1\/me\/(?:notification-preferences|devices|notifications)(?:\/|$)/.test(
        path,
      );
    } catch {
      return false;
    }
  }

  async handle(
    request: IncomingMessage & { originalUrl?: string; body?: unknown },
    response: ServerResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let route: Route | null;
    let url: URL;
    try {
      url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      route = notificationRoute(request.method ?? '', url.pathname);
    } catch (error) {
      return fail(
        response,
        error instanceof RequestError ? 400 : 404,
        error instanceof RequestError ? 'VALIDATION_FAILED' : 'RESOURCE_NOT_FOUND',
      );
    }
    if (!route) return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const write = !['get-preferences', 'list-notifications'].includes(route.kind);
    const auth = await authenticate(request, response, this.validateSession, write);
    if (!auth) return;
    try {
      if (route.kind === 'get-preferences') {
        ensureQuery(url, []);
        const result = await this.client.call<RpcMessage, RpcMessage>(
          'GetNotificationPreferences',
          { actor_user_id: auth.actorUserId },
          auth.correlationId,
        );
        return json(response, 200, {
          data: preferenceProjection(result.preference),
          meta: { correlation_id: auth.correlationId },
        });
      }
      if (route.kind === 'list-notifications') {
        const result = await this.client.call<RpcMessage, RpcMessage>(
          'ListNotifications',
          { actor_user_id: auth.actorUserId, ...page(url) },
          auth.correlationId,
        );
        return json(response, 200, {
          data: list(result.items).map(notificationProjection),
          meta: {
            correlation_id: auth.correlationId,
            next_cursor: optionalString(result.next_cursor),
          },
        });
      }
      ensureQuery(url, []);
      if (route.kind === 'update-preferences') {
        const result = await this.client.call<RpcMessage, RpcMessage>(
          'UpdateNotificationPreferences',
          { actor_user_id: auth.actorUserId, ...preferenceInput(await requestBody(request)) },
          auth.correlationId,
        );
        return json(response, 200, {
          data: preferenceProjection(result.preference),
          meta: { correlation_id: auth.correlationId },
        });
      }
      if (route.kind === 'register-device') {
        const result = await this.client.call<RpcMessage, RpcMessage>(
          'RegisterDevice',
          { actor_user_id: auth.actorUserId, ...deviceInput(await requestBody(request)) },
          auth.correlationId,
        );
        return json(response, 200, {
          data: deviceProjection(result.device),
          meta: { correlation_id: auth.correlationId },
        });
      }
      noBody(request);
      if (route.kind === 'delete-device') {
        await this.client.call<RpcMessage, RpcMessage>(
          'DeleteDevice',
          { actor_user_id: auth.actorUserId, device_id: route.id },
          auth.correlationId,
        );
        response.statusCode = 204;
        return response.end();
      }
      const result = await this.client.call<RpcMessage, RpcMessage>(
        'MarkNotificationRead',
        { actor_user_id: auth.actorUserId, notification_id: route.id },
        auth.correlationId,
      );
      return json(response, 200, {
        data: notificationProjection(result.notification),
        meta: { correlation_id: auth.correlationId },
      });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, write);
    }
  }

  close(): void {
    this.client.close();
  }
}
