import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelationMiddleware } from '@wolfari/common';
import { describe, expect, it, vi } from 'vitest';
import { FinanceProxy } from './finance-proxy';
import { projectFundHistory } from './finance-history-http';

const fund = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const entry = {
  id: fund,
  fund_id: fund,
  actor_user_id: actor,
  action: 'UPDATE_FUND_BUDGET',
  entity_type: 'Fund',
  entity_id: fund,
  from_version: 1,
  to_version: 2,
  occurred_at: { seconds: '1793277296', nanos: 123456000 },
  correlation_id: actor,
};
function setup() {
  const session = vi.fn().mockResolvedValue({ user_id: actor });
  const client = { call: vi.fn().mockResolvedValue({ items: [entry] }), close: vi.fn() };
  const proxy = new FinanceProxy(session, client);
  async function invoke(suffix = '', extraHeaders = {}, method = 'GET') {
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
      url: `/api/v1/funds/${fund}/history${suffix}`,
      method,
      headers: { authorization: 'Bearer token', ...extraHeaders },
    } as unknown as IncomingMessage;
    await new Promise<void>((resolve, reject) =>
      new CorrelationMiddleware().use(request, response as unknown as ServerResponse, () => {
        void proxy
          .handle(request, response as unknown as ServerResponse)
          .then(() => resolve(), reject);
      }),
    );
    return { code: response.statusCode, headers, body };
  }
  return { session, client, invoke };
}

describe('API162 Gateway', () => {
  it('uses validated session identity, preserves microseconds and emits a private whitelist', async () => {
    const s = setup();
    s.client.call.mockResolvedValueOnce({
      items: [{ ...entry, details: { account_number: 'PRIVATE' }, secret: 'PRIVATE' }],
    });
    const response = await s.invoke('?limit=1', { 'x-user-id': fund });
    expect(response.code).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.body).toMatchObject({
      data: {
        next_cursor: null,
        items: [{ from_version: 1, to_version: 2, reason: null, system_actor: null }],
      },
    });
    expect(JSON.stringify(response.body)).toContain('.123456Z');
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE');
    expect(s.client.call).toHaveBeenCalledWith(
      'ListFundHistory',
      { fund_id: fund, actor_user_id: actor, limit: 1 },
      expect.any(String),
    );
  });
  it('accepts protobuf omitted empty repeated fields and zero nanos', () => {
    expect(projectFundHistory({}, fund, 20)).toEqual({ items: [], next_cursor: null });
    expect(
      projectFundHistory(
        { items: [{ ...entry, occurred_at: { seconds: '1793277296' } }] },
        fund,
        20,
      ).items[0]?.occurred_at,
    ).toMatch(/\.000000Z$/);
  });
  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=01',
    '?limit=1.5',
    '?cursor=',
    '?limit=1&limit=2',
    '?actor_user_id=bad',
    '?cursor=' + 'a'.repeat(1025),
  ])('rejects invalid query %s', async (suffix) => {
    const s = setup();
    expect((await s.invoke(suffix)).code).toBe(400);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('requires a session and exposes only GET', async () => {
    const s = setup();
    expect((await s.invoke('', { authorization: '' })).code).toBe(401);
    expect((await s.invoke('', {}, 'POST')).code).toBe(404);
    expect(s.client.call).not.toHaveBeenCalled();
  });
  it('does not turn corrupt upstream data into successful partial history', async () => {
    const s = setup();
    s.client.call.mockResolvedValueOnce({ items: [{ ...entry, fund_id: actor }] });
    expect((await s.invoke()).code).toBe(503);
  });
  it.each([
    { items: [{ ...entry, to_version: 2147483648 }] },
    { items: [{ ...entry, occurred_at: { seconds: '1', nanos: 123456789 } }] },
    { items: [], next_cursor: 'bad=' },
    { items: [{ ...entry, reason: 'x'.repeat(2001) }] },
  ])('rejects malformed response', (response) =>
    expect(() => projectFundHistory(response, fund, 20)).toThrow(),
  );
});
