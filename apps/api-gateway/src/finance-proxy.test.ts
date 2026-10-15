import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelationMiddleware } from '@wolfari/common';
import { FinanceProxy, projectDestination, projectFund } from './finance-proxy';

const id = '10000000-0000-4000-8000-000000000001',
  actor = '20000000-0000-4000-8000-000000000001';
const fund = {
  id,
  trip_id: id,
  holder_user_id: actor,
  currency: 'VND',
  budget_amount: undefined,
  current_balance: '9007199254740993',
  reserved_refund: '9007199254740992',
  available_balance: '1',
  status: 1,
  finance_version: 1,
};
const destination = {
  id,
  fund_id: id,
  destination_type: 1,
  is_default: false,
  active: true,
  version: 1,
};
function setup() {
  const client = { call: vi.fn().mockResolvedValue({ fund }), close: vi.fn() };
  const session = vi.fn().mockResolvedValue({ user_id: actor });
  const proxy = new FinanceProxy(session, client);
  async function invoke(
    path = `/api/v1/trips/${id}/fund`,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) {
    let body: unknown;
    const headers = new Map<string, string>();
    const response = {
      statusCode: 0,
      setHeader: (key: string, value: string) => headers.set(key, value),
      end: (value: string) => {
        body = JSON.parse(value);
      },
    };
    const request = {
      url: path,
      method: options.method ?? 'GET',
      body: options.body,
      headers: { authorization: 'Bearer test-token', ...options.headers },
    } as unknown as IncomingMessage;
    await new Promise<void>((resolve, reject) =>
      new CorrelationMiddleware().use(request, response as unknown as ServerResponse, () => {
        void proxy
          .handle(request, response as unknown as ServerResponse)
          .then(() => resolve(), reject);
      }),
    );
    return { code: response.statusCode, body, headers };
  }
  return { client, session, proxy, invoke };
}
describe('Finance Gateway reads', () => {
  it('routes Fund before Trip proxy and obtains actor exclusively from Identity', async () => {
    const s = setup();
    expect(s.proxy.matches({ url: `/api/v1/trips/${id}/fund` } as IncomingMessage)).toBe(true);
    const result = await s.invoke();
    expect(result.code).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.body).toMatchObject({
      data: { budget_amount: null, available_balance: '1' },
      meta: { correlation_id: expect.any(String) },
    });
    expect(s.client.call).toHaveBeenCalledWith(
      'GetFund',
      { trip_id: id, actor_user_id: actor },
      expect.any(String),
    );
  });
  it.each(['?actor_user_id=forged', '?role=OWNER', '?include_private=true'])(
    'rejects unsupported query %s',
    async (query) => {
      const s = setup();
      expect((await s.invoke(`/api/v1/trips/${id}/fund${query}`)).code).toBe(400);
      expect(s.client.call).not.toHaveBeenCalled();
    },
  );
  it('rejects bad IDs, GET bodies and unsupported write routes', async () => {
    const s = setup();
    expect((await s.invoke('/api/v1/trips/bad/fund')).code).toBe(400);
    expect((await s.invoke(undefined, { headers: { 'content-length': '2' } })).code).toBe(400);
    expect((await s.invoke(undefined, { method: 'POST' })).code).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('requires valid authentication before forwarding any request', async () => {
    const s = setup();
    expect((await s.invoke(undefined, { headers: { authorization: '' } })).code).toBe(401);
    s.session.mockRejectedValue({ code: 16 });
    expect((await s.invoke()).code).toBe(401);
    s.session.mockRejectedValue({ code: 14 });
    expect((await s.invoke()).code).toBe(503);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('returns empty lists and refuses malformed or cross-Fund lists', async () => {
    const s = setup(),
      path = `/api/v1/funds/${id}/destinations`;
    s.client.call.mockResolvedValue({});
    expect((await s.invoke(path)).body).toMatchObject({ data: [] });
    s.client.call.mockResolvedValue({ destinations: [destination] });
    expect((await s.invoke(path)).code).toBe(200);
    s.client.call.mockResolvedValue({ destinations: [{ ...destination, fund_id: actor }] });
    expect((await s.invoke(path)).code).toBe(503);
    s.client.call.mockResolvedValue({ destinations: 'bad' });
    expect((await s.invoke(path)).code).toBe(503);
    s.client.call.mockResolvedValue({ fund: { ...fund, trip_id: actor } });
    expect((await s.invoke()).code).toBe(503);
  });
  it.each([
    [{ details: '{"code":"RESOURCE_NOT_FOUND"}' }, 404],
    [{ code: 7 }, 503],
    [{ code: 4 }, 503],
  ])('maps downstream error %j without exposing internals', async (error, code) => {
    const s = setup();
    s.client.call.mockRejectedValue(error);
    expect((await s.invoke()).code).toBe(code);
  });
  it('strips unknown fields, preserves null versus zero and rejects imprecise money', () => {
    expect(
      projectFund({ ...fund, budget_amount: '0', account_number: 'private' }),
    ).not.toHaveProperty('account_number');
    expect(projectFund({ ...fund, budget_amount: '0' }).budget_amount).toBe('0');
    for (const budget_amount of [1, '-1', '1.5', '9223372036854775808'])
      expect(() => projectFund({ ...fund, budget_amount })).toThrow();
    expect(() => projectFund({ ...fund, available_balance: '2' })).toThrow();
  });
  it('preserves absence of private data and whitelists only the current provider fields', () => {
    expect(projectDestination(destination)).not.toHaveProperty('account_number');
    const full = projectDestination({
      ...destination,
      bank_code: 'TEST',
      account_number: '00123',
      account_name: 'TEST',
      momo_phone: 'private',
      evidence: 'private',
    });
    expect(full).toHaveProperty('account_number', '00123');
    expect(full).not.toHaveProperty('momo_phone');
    expect(full).not.toHaveProperty('evidence');
    expect(() => projectDestination({ ...destination, account_number: '00123' })).toThrow();
  });
});

describe('Finance Gateway writes', () => {
  it('accepts leading-zero input Money but rejects whitespace, overflow and non-digits', async () => {
    for (const amount of [
      '000000000000000000000001',
      '0',
      '9223372036854775807',
      '1\n',
      '9223372036854775808',
      '',
    ]) {
      const s = setup();
      const valid = ['000000000000000000000001', '0', '9223372036854775807'].includes(amount);
      expect(
        (
          await s.invoke(`/api/v1/funds/${id}/budget`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'idempotency-key': id },
            body: { budget_amount: amount, expected_finance_version: 1 },
          })
        ).code,
      ).toBe(valid ? 200 : 400);
      expect(s.client.call).toHaveBeenCalledTimes(valid ? 1 : 0);
    }
  });
  it('maps null budget and false patch without losing presence', async () => {
    const s = setup(),
      headers = { 'content-type': 'application/json', 'idempotency-key': id };
    expect(
      (
        await s.invoke(`/api/v1/funds/${id}/budget`, {
          method: 'PATCH',
          headers,
          body: { budget_amount: null, expected_finance_version: 1 },
        })
      ).code,
    ).toBe(200);
    expect(s.client.call).toHaveBeenLastCalledWith(
      'UpdateFundBudget',
      expect.objectContaining({ budget: { clear: true } }),
      expect.any(String),
    );
    s.client.call.mockResolvedValue({ destination });
    expect(
      (
        await s.invoke(`/api/v1/funds/${id}/destinations/${id}`, {
          method: 'PATCH',
          headers,
          body: { active: false, expected_version: 1, expected_finance_version: 1 },
        })
      ).code,
    ).toBe(200);
    expect(s.client.call).toHaveBeenLastCalledWith(
      'UpdatePaymentDestination',
      expect.objectContaining({ patch: { active: false } }),
      expect.any(String),
    );
  });
  it.each([
    ['budget', { expected_finance_version: 1 }],
    ['budget', { budget_amount: 100, expected_finance_version: 1 }],
    ['budget', { budget_amount: null, expected_finance_version: '1' }],
    [`destinations/${id}`, { active: null, expected_version: 1, expected_finance_version: 1 }],
    [`destinations/${id}`, { expected_version: 1, expected_finance_version: 1 }],
    [
      `destinations/${id}`,
      { active: true, actor_user_id: actor, expected_version: 1, expected_finance_version: 1 },
    ],
  ])('rejects invalid configuration JSON %s %j before transport', async (suffix, body) => {
    const s = setup();
    expect(
      (
        await s.invoke(`/api/v1/funds/${id}/${suffix}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'idempotency-key': id },
          body,
        })
      ).code,
    ).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  const input = {
    holder_user_id: actor,
    currency: 'VND',
    destination: {
      destination_type: 'VIETQR',
      active: true,
      is_default: true,
      bank_code: 'TEST',
      account_number: '001',
      account_name: 'Holder',
    },
  };
  const headers = { 'content-type': 'application/json', 'idempotency-key': id };
  it('forwards typed enable with trusted actor and idempotency key', async () => {
    const s = setup();
    const result = await s.invoke(undefined, { method: 'POST', headers, body: input });
    expect(result.code).toBe(201);
    expect(s.client.call).toHaveBeenCalledWith(
      'EnableFund',
      { ...input, operation_id: id, actor_user_id: actor, trip_id: id },
      expect.any(String),
    );
  });
  it.each([
    { ...input, actor_user_id: id },
    { ...input, budget_amount: null },
    { ...input, budget_amount: 100 },
    { ...input, destination: { ...input.destination, active: 'true' } },
    { ...input, destination: { ...input.destination, confirmed_by_holder_at: 'forged' } },
    { ...input, destination: { ...input.destination, momo_phone: '0123' } },
  ])('rejects malformed JSON before protobuf can coerce or drop fields', async (body) => {
    const s = setup();
    expect((await s.invoke(undefined, { method: 'POST', headers, body })).code).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('projects pending operation without leaking receipt fields', async () => {
    const s = setup();
    s.client.call.mockResolvedValue({
      operation: {
        operation_id: id,
        trip_id: id,
        state: 2,
        command_payload: { account: 'private' },
      },
    });
    const result = await s.invoke(undefined, { method: 'POST', headers, body: input });
    expect(result.code).toBe(202);
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
  it('validates confirmation versions and scope', async () => {
    const s = setup(),
      path = `/api/v1/funds/${id}/destinations/${id}/confirm`;
    s.client.call.mockResolvedValue({ destination });
    expect(
      (
        await s.invoke(path, {
          method: 'POST',
          headers,
          body: { expected_version: 1, expected_finance_version: 1 },
        })
      ).code,
    ).toBe(200);
    expect(
      (
        await s.invoke(path, {
          method: 'POST',
          headers,
          body: { expected_version: '1', expected_finance_version: 1 },
        })
      ).code,
    ).toBe(400);
    s.client.call.mockResolvedValue({ destination: { ...destination, id: actor } });
    expect(
      (
        await s.invoke(path, {
          method: 'POST',
          headers,
          body: { expected_version: 1, expected_finance_version: 1 },
        })
      ).code,
    ).toBe(503);
  });
});
