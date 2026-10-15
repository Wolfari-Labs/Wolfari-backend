import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FinanceClient } from './finance-client';
import { projectContribution, projectContributionRequest } from './contribution-request-http';
import { projectOperation } from './membership-proxy';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  idempotencyKey,
  json,
  onlyKeys,
  requestBody,
  RequestError,
  uuid,
  type SessionValidator,
} from './trip-http';

export function contributionManagementRoute(path: string) {
  const request = /^\/api\/v1\/funds\/([^/]+)\/contribution-requests\/([^/]+)$/.exec(path);
  const contribution = /^\/api\/v1\/contributions\/([^/]+)(?:\/(waive|cancel))?$/.exec(path);
  if (request)
    return {
      method: 'PATCH',
      rpc: 'UpdateContributionRequest' as const,
      fund_id: request[1]!,
      request_id: request[2]!,
    };
  if (!contribution) return undefined;
  return {
    method: contribution[2] ? 'POST' : 'PATCH',
    rpc:
      contribution[2] === 'waive'
        ? ('WaiveContribution' as const)
        : contribution[2] === 'cancel'
          ? ('CancelContribution' as const)
          : ('UpdateContributionAmount' as const),
    contribution_id: contribution[1]!,
  };
}
export async function handleContributionManagement(
  request: IncomingMessage & { body?: unknown },
  response: ServerResponse,
  url: URL,
  route: NonNullable<ReturnType<typeof contributionManagementRoute>>,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== route.method) return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, true);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    const ids =
      route.rpc === 'UpdateContributionRequest'
        ? { fund_id: route.fund_id, request_id: route.request_id }
        : { contribution_id: route.contribution_id };
    if (Object.values(ids).some((value) => !uuid.test(value!)))
      throw new RequestError('Invalid ID');
    const operationId = idempotencyKey(request, true);
    const body = await requestBody(request);
    const fields =
      route.rpc === 'UpdateContributionRequest'
        ? ['title', 'due_at', 'note']
        : route.rpc === 'UpdateContributionAmount'
          ? ['amount']
          : ['reason'];
    onlyKeys(body, [...fields, 'expected_version', 'expected_finance_version']);
    if (!fields.some((key) => Object.hasOwn(body, key))) throw new RequestError('Empty patch');
    for (const key of fields.filter((key) => Object.hasOwn(body, key)))
      if (typeof body[key] !== 'string') throw new RequestError('Invalid field');
    for (const key of ['expected_version', 'expected_finance_version'])
      if (!Number.isInteger(body[key]) || Number(body[key]) < 1 || Number(body[key]) > 2147483647)
        throw new RequestError('Invalid version');
    const result = await client.call(
      route.rpc,
      {
        ...body,
        ...Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v!.toLowerCase()])),
        operation_id: operationId,
        actor_user_id: auth.actorUserId,
      },
      auth.correlationId,
    );
    if (result.operation) {
      if (result.contribution || result.contribution_request) throw new Error('Ambiguous result');
      const data = projectOperation(result.operation);
      if (
        data.operation_id !== operationId ||
        !['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(data.state)
      )
        throw new Error('Invalid operation');
      return json(response, 202, { data, meta: { correlation_id: auth.correlationId } });
    }
    if (route.rpc === 'UpdateContributionRequest') {
      const data = projectContributionRequest(result.contribution_request, false);
      if (
        data.id !== route.request_id.toLowerCase() ||
        data.fund_id !== route.fund_id.toLowerCase() ||
        data.status !== 'OPEN'
      )
        throw new Error('Invalid updated request');
      return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
    }
    const data = projectContribution(result.contribution);
    const expected = {
      UpdateContributionAmount: 'PENDING',
      WaiveContribution: 'WAIVED',
      CancelContribution: 'CANCELLED',
    }[route.rpc];
    if (data.id !== route.contribution_id.toLowerCase() || data.status !== expected)
      throw new Error('Invalid updated contribution');
    return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, true);
  }
}
