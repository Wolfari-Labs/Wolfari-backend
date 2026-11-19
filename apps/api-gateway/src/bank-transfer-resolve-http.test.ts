import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelationMiddleware } from '@wolfari/common';
import { describe, expect, it, vi } from 'vitest';
import { bankRoute } from './bank-webhook-http';
import { FinanceProxy } from './finance-proxy';

const id = '10000000-0000-4000-8000-000000000001';
const transferId = '60000000-0000-4000-8000-000000000001';
const input = { resolution: 'RETURNED_TO_SENDER', note: 'Đã chuyển trả 50.000 đ', expected_finance_version: 4 };
const resolved = {
  id: transferId,
  provider: 'SEPAY',
  provider_transaction_id: '92704',
  transfer_type: 'IN',
  amount: '50000',
  content: 'CK quy',
  account_number_masked: '******4567',
  bank_gateway: 'Vietcombank',
  processing_status: 'RESOLVED',
  review_reason: 'AMOUNT_MISMATCH',
  received_at: { seconds: '1792000001', nanos: 0 },
  resolution: 'RETURNED_TO_SENDER',
  resolution_note: input.note,
  resolved_by_user_id: id,
  resolved_at: { seconds: '1792000100', nanos: 0 },
};

function setup(result: unknown = { bank_transfer: resolved, finance_version: 5 }) {
  const client = { call: vi.fn().mockResolvedValue(result), close: vi.fn() };
  const session = vi.fn().mockResolvedValue({ user_id: id });
  const proxy = new FinanceProxy(session, client);
  async function invoke(
    body: unknown = input,
    options: { key?: string; method?: string; path?: string } = {},
  ) {
    let payload: unknown;
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: (value: string) => {
        payload = JSON.parse(value);
      },
    };
    const request = {
      url: options.path ?? `/api/v1/funds/${id}/bank-transfers/${transferId}/resolve`,
      method: options.method ?? 'POST',
      body,
      headers: {
        authorization: 'Bearer fixture',
        'idempotency-key': options.key ?? id,
        'content-type': 'application/json',
      },
    } as unknown as IncomingMessage;
    expect(proxy.matches(request)).toBe(true);
    await new Promise<void>((resolve, reject) =>
      new CorrelationMiddleware().use(request, response as unknown as ServerResponse, () => {
        void proxy.handle(request, response as unknown as ServerResponse).then(() => resolve(), reject);
      }),
    );
    return { status: response.statusCode, payload };
  }
  return { invoke, client };
}

describe('Bank transfer resolve HTTP', () => {
  it('routes only the resolve path of one transfer', () => {
    expect(bankRoute(`/api/v1/funds/${id}/bank-transfers/${transferId}/resolve`)).toEqual({
      kind: 'resolve',
      fundId: id,
      transferId,
    });
    expect(bankRoute(`/api/v1/funds/${id}/bank-transfers/${transferId}`)).toBeUndefined();
    expect(bankRoute(`/api/v1/funds/${id}/bank-transfers/${transferId}/resolve/x`)).toBeUndefined();
  });

  it('forwards the Holder intent with the idempotency key and projects the resolved row', async () => {
    const f = setup();
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect(f.client.call).toHaveBeenCalledWith(
      'ResolveBankTransfer',
      {
        operation_id: id,
        actor_user_id: id,
        fund_id: id,
        bank_transfer_id: transferId,
        ...input,
      },
      expect.any(String),
    );
    expect(response.payload).toMatchObject({
      data: {
        id: transferId,
        processing_status: 'RESOLVED',
        resolution: 'RETURNED_TO_SENDER',
        resolution_note: input.note,
        resolved_by_user_id: id,
      },
    });
  });

  it('rejects bad methods, keys and bodies before any RPC', async () => {
    const f = setup();
    expect((await f.invoke(input, { method: 'GET' })).status).toBe(404);
    expect((await f.invoke(input, { key: 'not-a-uuid' })).status).toBe(400);
    for (const body of [
      { ...input, resolution: 'GUESS' },
      { ...input, note: '   ' },
      { ...input, note: 'x'.repeat(501) },
      { ...input, expected_finance_version: 0 },
      { ...input, expected_finance_version: '4' },
      { ...input, extra: true },
      { resolution: input.resolution, note: input.note },
    ])
      expect((await f.invoke(body)).status, JSON.stringify(body)).toBe(400);
    expect(f.client.call).not.toHaveBeenCalled();
  });

  it('fails closed when the service answers for a different or unresolved transfer', async () => {
    expect(
      (await setup({ bank_transfer: { ...resolved, id }, finance_version: 5 }).invoke()).status,
    ).toBe(503);
    expect(
      (
        await setup({
          bank_transfer: {
            ...resolved,
            processing_status: 'NEEDS_REVIEW',
            resolution: undefined,
            resolution_note: undefined,
            resolved_by_user_id: undefined,
            resolved_at: undefined,
          },
          finance_version: 5,
        }).invoke()
      ).status,
    ).toBe(503);
  });
});
