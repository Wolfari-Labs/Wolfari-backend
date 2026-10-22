import { handlePaymentInstruction } from './payment-instruction-http';
import { expenseRoute, handleExpense } from './expense-http';
import { financialNoteRoute, handleFinancialNote } from './financial-note-http';
import { refundRoute, handleRefund } from './refund-http';
import { closureRoute, handleClosure } from './closure-http';
import { FinanceReceiptHttp, receiptRoute } from './finance-receipt-http';
import {
  contributionManagementRoute,
  handleContributionManagement,
} from './contribution-management-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FinanceClient } from './finance-client';
import {
  validateContributionRequestBody,
  projectContributionRequest,
  contributionPageQuery,
  projectContributionPage,
} from './contribution-request-http';
import { projectOperation } from './membership-proxy';
import { projectLedgerPage } from './ledger-projection';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  json,
  RequestError,
  responseRecord,
  requiredInteger,
  requiredString,
  timestampToIso,
  uuid,
  requestBody,
  onlyKeys,
  idempotencyKey,
  type SessionValidator,
} from './trip-http';

const money = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 19 ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error('Invalid Finance money');
  return value;
};
// Input Money permits leading zeros; stored response Money remains canonical.
const inputMoney = (value: unknown): void => {
  if (typeof value !== 'string' || !value.length || /[^0-9]/u.test(value))
    throw new RequestError('Invalid Finance money');
  try {
    money(value.replace(/^0+/u, '') || '0');
  } catch {
    throw new RequestError('Invalid Finance money');
  }
};
const identifier = (value: unknown) => {
  const result = requiredString(value);
  if (!uuid.test(result)) throw new Error('Invalid Finance ID');
  return result;
};
const version = (value: unknown) => {
  const result = requiredInteger(value);
  if (result > 2147483647) throw new Error('Invalid Finance version');
  return result;
};
const nullableTimestamp = (value: unknown) =>
  value === undefined || value === null ? null : timestampToIso(value);
const bool = (value: unknown) => {
  if (typeof value !== 'boolean') throw new Error('Invalid Finance flag');
  return value;
};
export function projectFund(value: unknown) {
  const row = responseRecord(value);
  const status = { 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' }[Number(row.status)];
  if (!status || row.currency !== 'VND') throw new Error('Invalid Finance response');
  const balance = money(row.current_balance),
    reserved = money(row.reserved_refund),
    available = money(row.available_balance);
  if (BigInt(balance) - BigInt(reserved) !== BigInt(available))
    throw new Error('Invalid Finance balance');
  return {
    id: identifier(row.id),
    trip_id: identifier(row.trip_id),
    holder_user_id: identifier(row.holder_user_id),
    currency: 'VND',
    budget_amount: row.budget_amount === undefined ? null : money(row.budget_amount),
    current_balance: balance,
    reserved_refund: reserved,
    available_balance: available,
    status,
    finance_version: version(row.finance_version),
    closed_at: nullableTimestamp(row.closed_at),
  };
}
export function projectDestination(value: unknown) {
  const row = responseRecord(value);
  const type = { 1: 'VIETQR', 2: 'MOMO_SANDBOX' }[Number(row.destination_type)];
  if (!type) throw new Error('Invalid Finance destination');
  const privateFields =
    type === 'VIETQR' ? ['bank_code', 'account_number', 'account_name'] : ['momo_phone'];
  const present = privateFields.filter((key) => row[key] !== undefined);
  if (present.length !== 0 && present.length !== privateFields.length)
    throw new Error('Incomplete Finance destination');
  return {
    id: identifier(row.id),
    fund_id: identifier(row.fund_id),
    destination_type: type,
    is_default: bool(row.is_default),
    active: bool(row.active),
    version: version(row.version),
    confirmed_by_holder_at: nullableTimestamp(row.confirmed_by_holder_at),
    ...Object.fromEntries(present.map((key) => [key, requiredString(row[key])])),
  };
}
type Request = IncomingMessage & { originalUrl?: string; body?: unknown };
export class FinanceProxy {
  private readonly client: Pick<FinanceClient, 'call' | 'close'>;
  private readonly files: FinanceReceiptHttp;
  constructor(
    private readonly validateSession: SessionValidator,
    client?: Pick<FinanceClient, 'call' | 'close'>,
  ) {
    this.files = new FinanceReceiptHttp(validateSession);
    this.client =
      client ??
      new FinanceClient(
        process.env.FINANCE_GRPC_TARGET ?? '127.0.0.1:3204',
        process.env.GATEWAY_FINANCE_SECRET ?? '',
      );
  }
  matches(request: Request) {
    const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
    return (
      /^\/api\/v1\/trips\/[^/]+\/fund(?:\/|$)/.test(path) ||
      /^\/api\/v1\/(?:funds|contributions)(?:\/|$)/.test(path) ||
      /^\/api\/v1\/expenses(?:\/|$)/.test(path) ||
      /^\/api\/v1\/notes(?:\/|$)/.test(path) ||
      /^\/api\/v1\/refunds(?:\/|$)/.test(path) ||
      /^\/api\/v1\/closures(?:\/|$)/.test(path)
    );
  }
  async handle(request: Request, response: ServerResponse) {
    const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
    const closure = closureRoute(url.pathname);
    if (closure)
      return handleClosure(request, response, url, closure, this.validateSession, this.client);
    const expense = expenseRoute(url.pathname);
    if (expense)
      return handleExpense(request, response, url, expense, this.validateSession, this.client);
    const refund = refundRoute(url.pathname);
    if (refund)
      return handleRefund(request, response, url, refund, this.validateSession, this.client);
    const note = financialNoteRoute(url.pathname);
    if (note)
      return handleFinancialNote(request, response, url, note, this.validateSession, this.client);
    const instruction = /^\/api\/v1\/contributions\/([^/]+)\/vietqr$/.exec(url.pathname);
    if (instruction)
      return handlePaymentInstruction(
        request,
        response,
        url,
        instruction[1]!,
        this.validateSession,
        this.client,
      );
    const fileRoute = receiptRoute(url.pathname);
    if (fileRoute) return this.files.handle(request, response, url, fileRoute);
    const management = contributionManagementRoute(url.pathname);
    if (management)
      return handleContributionManagement(
        request,
        response,
        url,
        management,
        this.validateSession,
        this.client,
      );
    const fund = /^\/api\/v1\/trips\/([^/]+)\/fund$/.exec(url.pathname);
    const contributions = /^\/api\/v1\/funds\/([^/]+)\/contribution-requests$/.exec(url.pathname);
    const allocations = /^\/api\/v1\/funds\/([^/]+)\/contributions$/.exec(url.pathname);
    const destinations = /^\/api\/v1\/funds\/([^/]+)\/destinations$/.exec(url.pathname);
    const transactions = /^\/api\/v1\/funds\/([^/]+)\/transactions$/.exec(url.pathname);
    const budget = /^\/api\/v1\/funds\/([^/]+)\/budget$/.exec(url.pathname);
    const edit = /^\/api\/v1\/funds\/([^/]+)\/destinations\/([^/]+)$/.exec(url.pathname);
    const confirm = /^\/api\/v1\/funds\/([^/]+)\/destinations\/([^/]+)\/confirm$/.exec(
      url.pathname,
    );
    const write =
      (request.method === 'POST' && Boolean(fund || confirm || destinations || contributions)) ||
      (request.method === 'PATCH' && Boolean(budget || edit));
    if (
      !write &&
      (request.method !== 'GET' ||
        (!fund && !destinations && !contributions && !allocations && !transactions))
    )
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const auth = await authenticate(request, response, this.validateSession, write);
    if (!auth) return;
    try {
      const listing = !write && Boolean(contributions || allocations);
      ensureQuery(
        url,
        listing
          ? ['limit', 'cursor', ...(allocations ? ['status', 'member_user_id'] : [])]
          : transactions
            ? ['limit', 'cursor']
            : [],
      );
      const id = (fund ??
        destinations ??
        confirm ??
        budget ??
        edit ??
        contributions ??
        allocations ??
        transactions)![1]!;
      if (write) {
        if (!uuid.test(id) || ((confirm || edit) && !uuid.test((confirm ?? edit)![2]!)))
          throw new RequestError('Invalid ID');
        const operationId = idempotencyKey(request, true);
        const body = await requestBody(request);
        // Validate JSON types before protobuf can coerce values or discard unknown fields.
        if (contributions) {
          validateContributionRequestBody(body);
        } else if (fund) {
          onlyKeys(body, ['holder_user_id', 'currency', 'budget_amount', 'destination']);
          if (
            typeof body.holder_user_id !== 'string' ||
            !uuid.test(body.holder_user_id) ||
            body.currency !== 'VND'
          )
            throw new RequestError('Invalid Fund input');
          if (Object.hasOwn(body, 'budget_amount')) inputMoney(body.budget_amount);
          if (
            !body.destination ||
            typeof body.destination !== 'object' ||
            Array.isArray(body.destination)
          )
            throw new RequestError('Invalid destination');
          const destination = body.destination as Record<string, unknown>;
          const fields =
            destination.destination_type === 'VIETQR'
              ? ['bank_code', 'account_number', 'account_name']
              : destination.destination_type === 'MOMO_SANDBOX'
                ? ['momo_phone']
                : undefined;
          if (
            !fields ||
            typeof destination.active !== 'boolean' ||
            typeof destination.is_default !== 'boolean' ||
            fields.some((key) => typeof destination[key] !== 'string')
          )
            throw new RequestError('Invalid destination');
          onlyKeys(destination, ['destination_type', 'active', 'is_default', ...fields]);
        } else if (budget) {
          onlyKeys(body, ['budget_amount', 'expected_finance_version']);
          if (body.budget_amount !== null) {
            inputMoney(body.budget_amount);
          }
        } else if (destinations || edit) {
          const fields = [
            'destination_type',
            'bank_code',
            'account_number',
            'account_name',
            'momo_phone',
            'active',
            'is_default',
          ];
          onlyKeys(body, [
            ...fields,
            'expected_finance_version',
            ...(edit ? ['expected_version'] : []),
          ]);
          const keys = fields.filter((key) => Object.hasOwn(body, key));
          if (!keys.length) throw new RequestError('Empty destination patch');
          for (const key of keys) {
            if (key === 'active' || key === 'is_default') {
              if (typeof body[key] !== 'boolean') throw new RequestError('Invalid flag');
            } else if (typeof body[key] !== 'string') throw new RequestError('Invalid destination');
          }
          if (
            Object.hasOwn(body, 'destination_type') &&
            !['VIETQR', 'MOMO_SANDBOX'].includes(String(body.destination_type))
          )
            throw new RequestError('Invalid destination type');
          if (destinations) {
            const recipient =
              body.destination_type === 'VIETQR'
                ? ['bank_code', 'account_number', 'account_name']
                : body.destination_type === 'MOMO_SANDBOX'
                  ? ['momo_phone']
                  : undefined;
            if (
              !recipient ||
              ['active', 'is_default', ...recipient].some((key) => !Object.hasOwn(body, key))
            )
              throw new RequestError('Incomplete destination');
            onlyKeys(body, [
              'destination_type',
              'active',
              'is_default',
              ...recipient,
              'expected_finance_version',
            ]);
          }
        } else {
          onlyKeys(body, ['expected_version', 'expected_finance_version']);
        }
        if (!fund) {
          for (const key of [
            ...(confirm || edit ? ['expected_version'] : []),
            'expected_finance_version',
          ])
            if (
              !Number.isInteger(body[key]) ||
              Number(body[key]) < 1 ||
              Number(body[key]) > 2147483647
            )
              throw new RequestError('Invalid version');
        }
        const configuration = Object.fromEntries(
          Object.entries(body).filter(
            ([key]) => key !== 'expected_version' && key !== 'expected_finance_version',
          ),
        );
        const payload = budget
          ? {
              budget: body.budget_amount === null ? { clear: true } : { value: body.budget_amount },
              expected_finance_version: body.expected_finance_version,
            }
          : destinations
            ? {
                destination: configuration,
                expected_finance_version: body.expected_finance_version,
              }
            : edit
              ? {
                  patch: configuration,
                  expected_version: body.expected_version,
                  expected_finance_version: body.expected_finance_version,
                }
              : body;
        const result = await this.client.call(
          contributions
            ? 'CreateContributionRequest'
            : fund
              ? 'EnableFund'
              : budget
                ? 'UpdateFundBudget'
                : destinations
                  ? 'CreatePaymentDestination'
                  : edit
                    ? 'UpdatePaymentDestination'
                    : 'ConfirmPaymentDestination',
          {
            ...payload,
            operation_id: operationId,
            actor_user_id: auth.actorUserId,
            ...(fund
              ? { trip_id: id.toLowerCase() }
              : {
                  fund_id: id.toLowerCase(),
                  ...(confirm || edit
                    ? { destination_id: (confirm ?? edit)![2]!.toLowerCase() }
                    : {}),
                }),
          },
          auth.correlationId,
        );
        if (result.operation) {
          const operation = projectOperation(result.operation);
          if (
            operation.operation_id !== operationId ||
            !['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(operation.state)
          )
            throw new Error('Invalid pending result');
          return json(response, 202, {
            data: operation,
            meta: { correlation_id: auth.correlationId },
          });
        }
        if (contributions) {
          const data = projectContributionRequest(result.contribution_request);
          if (data.fund_id !== id.toLowerCase() || data.created_by_user_id !== auth.actorUserId)
            throw new Error('Contribution request scope mismatch');
          return json(response, 201, { data, meta: { correlation_id: auth.correlationId } });
        }
        const data =
          fund || budget ? projectFund(result.fund) : projectDestination(result.destination);
        if (
          fund
            ? !('trip_id' in data) || data.trip_id !== id.toLowerCase()
            : budget
              ? data.id !== id.toLowerCase()
              : !('fund_id' in data) ||
                data.fund_id !== id.toLowerCase() ||
                Boolean((confirm || edit) && data.id !== (confirm ?? edit)![2]!.toLowerCase())
        )
          throw new Error('Write scope mismatch');
        return json(response, fund || destinations ? 201 : 200, {
          data,
          meta: { correlation_id: auth.correlationId },
        });
      }
      if (
        !uuid.test(id) ||
        (request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined ||
        (request.body !== undefined && Object.keys(responseRecord(request.body)).length > 0)
      )
        throw new RequestError('Invalid Finance read request');
      const normalized = id.toLowerCase();
      if (listing) {
        const query = contributionPageQuery(url, Boolean(contributions));
        const result = await this.client.call(
          contributions ? 'ListContributionRequests' : 'ListContributions',
          { fund_id: normalized, actor_user_id: auth.actorUserId, ...query },
          auth.correlationId,
        );
        const data = projectContributionPage(result, normalized, Boolean(contributions), query);
        return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
      }
      if (transactions) {
        const rawLimit = url.searchParams.get('limit') ?? '20';
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (
          !rawLimit.length ||
          /[^0-9]/u.test(rawLimit) ||
          Number(rawLimit) < 1 ||
          Number(rawLimit) > 100 ||
          (cursor !== undefined &&
            (!cursor.length || cursor.length > 512 || /[^A-Za-z0-9_-]/u.test(cursor)))
        )
          throw new RequestError('Invalid ledger pagination');
        const limit = Number(rawLimit);
        const result = await this.client.call(
          'ListFundTransactions',
          {
            fund_id: normalized,
            actor_user_id: auth.actorUserId,
            limit,
            cursor,
          },
          auth.correlationId,
        );
        return json(response, 200, {
          data: projectLedgerPage(result, normalized, limit),
          meta: { correlation_id: auth.correlationId },
        });
      }
      const result = await this.client.call(
        fund ? 'GetFund' : 'ListPaymentDestinations',
        { [fund ? 'trip_id' : 'fund_id']: normalized, actor_user_id: auth.actorUserId },
        auth.correlationId,
      );
      let data;
      if (fund) {
        data = projectFund(result.fund);
        if (data.trip_id !== normalized) throw new Error('Fund scope mismatch');
      } else {
        const rows = result.destinations ?? [];
        if (!Array.isArray(rows)) throw new Error('Invalid Finance list');
        data = rows.map(projectDestination);
        if (data.some((row) => row.fund_id !== normalized))
          throw new Error('Destination scope mismatch');
      }
      return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, write);
    }
  }
  close() {
    this.client.close();
    this.files.close();
  }
}
