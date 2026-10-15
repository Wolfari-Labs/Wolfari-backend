import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelationMiddleware } from '@wolfari/common';
import { FinanceProxy, projectDestination, projectFund } from './finance-proxy';
import { projectLedgerPage } from './ledger-projection';

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
describe('Contribution request Gateway', () => {
  const path = `/api/v1/funds/${id}/contribution-requests`;
  const body = {
    title: 'Meals',
    contributions: [{ member_user_id: actor, amount: '300000', destination_id: id }],
    expected_finance_version: 2,
  };
  const view = {
    id,
    fund_id: id,
    title: 'Meals',
    status: 'OPEN',
    version: 1,
    created_by_user_id: actor,
    created_at: { seconds: '1792000000', nanos: 0 },
    destination_snapshot: { account_number: 'PRIVATE' },
  };
  it('uses session identity, whitelists response and emits 201 with null optional fields', async () => {
    const s = setup();
    s.client.call.mockResolvedValue({ contribution_request: view } as never);
    const r = await s.invoke(path, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'idempotency-key': id },
    });
    expect(r.code).toBe(201);
    expect(r.body).toMatchObject({
      data: { fund_id: id, note: null, due_at: null, amount_per_member: null },
    });
    expect(JSON.stringify(r.body)).not.toContain('PRIVATE');
    expect(s.client.call).toHaveBeenCalledWith(
      'CreateContributionRequest',
      { ...body, fund_id: id, actor_user_id: actor, operation_id: id },
      expect.any(String),
    );
  });
  it.each([
    { actor_user_id: actor },
    { due_at: null },
    { note: 2 },
    { title: [] },
    { contributions: [] },
    { contributions: [{ ...body.contributions[0], amount: 100 }] },
    { contributions: [{ ...body.contributions[0], amount: '0' }] },
    { contributions: [{ ...body.contributions[0], status: 'CONFIRMED' }] },
    { contributions: [body.contributions[0], body.contributions[0]] },
  ])('rejects JSON before serialization', async (patch) => {
    const s = setup();
    expect(
      (
        await s.invoke(path, {
          method: 'POST',
          body: { ...body, ...patch },
          headers: { 'content-type': 'application/json', 'idempotency-key': id },
        })
      ).code,
    ).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('rejects mismatched Fund response and reads requests through the separate RPC', async () => {
    const s = setup();
    s.client.call.mockResolvedValue({ contribution_request: { ...view, fund_id: actor } } as never);
    expect(
      (
        await s.invoke(path, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json', 'idempotency-key': id },
        })
      ).code,
    ).toBe(503);
    s.client.call.mockResolvedValue({ items: [] } as never);
    expect((await s.invoke(path)).code).toBe(200);
    expect(s.client.call).toHaveBeenLastCalledWith(
      'ListContributionRequests',
      { fund_id: id, actor_user_id: actor },
      expect.any(String),
    );
  });
});

describe('Contribution list Gateway', () => {
  it.each(['contribution-requests', 'contributions'])(
    'authenticates %s and returns an empty page',
    async (endpoint) => {
      const s = setup();
      s.client.call.mockResolvedValue({} as never);
      const r = await s.invoke(`/api/v1/funds/${id}/${endpoint}?limit=100`);
      expect(r.code).toBe(200);
      expect(r.body).toMatchObject({ data: { items: [], next_cursor: null } });
      expect(s.client.call).toHaveBeenCalledWith(
        endpoint === 'contributions' ? 'ListContributions' : 'ListContributionRequests',
        { fund_id: id, actor_user_id: actor, limit: 100 },
        expect.any(String),
      );
      expect(
        (await s.invoke(`/api/v1/funds/${id}/${endpoint}`, { headers: { authorization: '' } }))
          .code,
      ).toBe(401);
    },
  );
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=01',
    'limit=1&limit=2',
    'status=bogus',
    'member_user_id=bad',
    'cursor=',
    'cursor=abc&cursor=def',
    'actor_user_id=' + actor,
    'request_id=' + id,
    'sort=asc',
  ])('rejects query %s before RPC', async (query) => {
    const s = setup();
    expect((await s.invoke(`/api/v1/funds/${id}/contributions?${query}`)).code).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('forwards canonical filters, rejects request-list filters and GET bodies', async () => {
    const s = setup();
    s.client.call.mockResolvedValue({} as never);
    expect(
      (await s.invoke(`/api/v1/funds/${id}/contributions?status=REVERSED&member_user_id=${actor}`))
        .code,
    ).toBe(200);
    expect(s.client.call).toHaveBeenCalledWith(
      'ListContributions',
      { fund_id: id, actor_user_id: actor, status: 'REVERSED', member_user_id: actor },
      expect.any(String),
    );
    expect((await s.invoke(`/api/v1/funds/${id}/contribution-requests?status=OPEN`)).code).toBe(
      400,
    );
    expect(
      (await s.invoke(`/api/v1/funds/${id}/contributions`, { body: { limit: 10 } })).code,
    ).toBe(400);
  });
});

describe('Finance Gateway reads', () => {
  it('routes ledger reads with trusted actor, default limit and nullable continuation', async () => {
    const s = setup();
    s.client.call.mockResolvedValue({ items: [] });
    const result = await s.invoke(`/api/v1/funds/${id}/transactions`);
    expect(result.code).toBe(200);
    expect(result.body).toMatchObject({ data: { items: [], next_cursor: null } });
    expect(s.client.call).toHaveBeenCalledWith(
      'ListFundTransactions',
      {
        fund_id: id,
        actor_user_id: actor,
        limit: 20,
        cursor: undefined,
      },
      expect.any(String),
    );
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=',
    'limit=1%0A',
    'limit=1&limit=2',
    'cursor=',
    'cursor=!',
    `cursor=${'a'.repeat(513)}`,
    'cursor=a&cursor=b',
    'actor_user_id=x',
    'sort=asc',
  ])('rejects ledger query %s before transport', async (query) => {
    const s = setup();
    expect((await s.invoke(`/api/v1/funds/${id}/transactions?${query}`)).code).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('whitelists exact ledger values and rejects malformed downstream pages', () => {
    const row = {
      id,
      fund_id: id,
      sequence: '9007199254740993',
      direction: 1,
      transaction_type: 'REVERSAL',
      amount: '9223372036854775807',
      balance_after: '0',
      reversal_of_id: actor,
      reason: 'Correction',
      created_at: { seconds: '0', nanos: 0 },
      business_key: 'PRIVATE',
      account_number: 'PRIVATE',
    };
    const result = projectLedgerPage({ items: [row] }, id, 20);
    expect(result.items[0]).toMatchObject({
      sequence: row.sequence,
      amount: row.amount,
      direction: 'IN',
      contribution_id: null,
      actor_user_id: null,
      created_at: '1970-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const patch of [
      { sequence: 9007199254740992 },
      { fund_id: actor },
      { amount: '0' },
      { sequence: '1\n' },
      { direction: 0 },
      { transaction_type: 'OTHER' },
      { created_at: null },
    ])
      expect(() => projectLedgerPage({ items: [{ ...row, ...patch }] }, id, 20)).toThrow();
    expect(() => projectLedgerPage({ items: [row, row] }, id, 20)).toThrow();
    expect(() => projectLedgerPage({ items: [row], next_cursor: 'abc' }, id, 20)).toThrow();
  });
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

describe('Contribution management Gateway', () => {
  const data = {
    id,
    request_id: id,
    fund_id: id,
    member_user_id: actor,
    amount: '300000',
    status: 'PENDING',
    self_contribution: false,
    version: 2,
    finance_version: 5,
  };
  const headers = { 'idempotency-key': id, 'content-type': 'application/json' };
  const versions = { expected_version: 1, expected_finance_version: 4 };
  it.each([
    ['PATCH', '', 'UpdateContributionAmount', { amount: '300000' }, 'PENDING'],
    ['POST', '/waive', 'WaiveContribution', { reason: 'Paid by group' }, 'WAIVED'],
    ['POST', '/cancel', 'CancelContribution', { reason: 'Mistake' }, 'CANCELLED'],
  ] as const)(
    'routes %s %s using session actor and path scope',
    async (method, suffix, rpc, fields, status) => {
      const s = setup();
      s.client.call.mockResolvedValue({
        contribution: {
          ...data,
          status,
          destination_snapshot: 'PRIVATE',
          transfer_evidence_object_key: 'PRIVATE',
        },
      });
      const result = await s.invoke(`/api/v1/contributions/${id}${suffix}`, {
        method,
        headers,
        body: { ...versions, ...fields },
      });
      expect(result.code).toBe(200);
      expect(s.client.call).toHaveBeenCalledWith(
        rpc,
        { ...versions, ...fields, contribution_id: id, operation_id: id, actor_user_id: actor },
        expect.any(String),
      );
      expect(JSON.stringify(result.body)).not.toContain('PRIVATE');
      expect(s.proxy.matches({ url: `/api/v1/contributions/${id}` } as IncomingMessage)).toBe(true);
    },
  );
  it('projects updated request with mixed contributions without weakening create validation', async () => {
    const s = setup();
    s.client.call.mockResolvedValue({
      contribution_request: {
        id,
        fund_id: id,
        title: 'Changed',
        status: 'OPEN',
        version: 4,
        created_by_user_id: id,
        created_at: { seconds: '1792000000', nanos: 0 },
        finance_version: 5,
        contributions: [{ ...data, status: 'CONFIRMED' }],
      },
    });
    expect(
      (
        await s.invoke(`/api/v1/funds/${id}/contribution-requests/${id}`, {
          method: 'PATCH',
          headers,
          body: { ...versions, note: '' },
        })
      ).code,
    ).toBe(200);
  });
  it.each([
    { amount: 12 },
    { amount: null },
    { amount: '2', actor_user_id: id },
    { amount: '2', fund_id: id },
    { amount: '2', expected_version: 0 },
    {},
  ])('rejects malformed JSON before RPC', async (patch) => {
    const s = setup();
    expect(
      (
        await s.invoke(`/api/v1/contributions/${id}`, {
          method: 'PATCH',
          headers,
          body: { ...versions, ...patch },
        })
      ).code,
    ).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it.each([
    { ...data, id: actor },
    { ...data, status: 'CONFIRMED' },
    { ...data, amount: '0' },
  ])('fails closed on invalid downstream result', async (contribution) => {
    const s = setup();
    s.client.call.mockResolvedValue({ contribution });
    expect(
      (
        await s.invoke(`/api/v1/contributions/${id}`, {
          method: 'PATCH',
          headers,
          body: { ...versions, amount: '300000' },
        })
      ).code,
    ).toBe(503);
  });
});
