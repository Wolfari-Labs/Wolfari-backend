import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  allowWebhookRequest,
  bankRoute,
  handleBankWebhook,
  parseSepayPayload,
  projectBankTransfer,
  sepayConfig,
  verifySepay,
} from './bank-webhook-http';

const secret = 's'.repeat(32);
const payload = {
  id: 92704,
  gateway: 'Vietcombank',
  transactionDate: '2026-11-12 20:15:00',
  accountNumber: '0001234567',
  subAccount: null,
  code: null,
  content: 'CK 0ABCDEFGHIJKLMNOPQRSTUVWX tien quy',
  transferType: 'in',
  transferAmount: 300000,
  referenceCode: 'FT26316ABC',
  description: 'MBVCB.123',
  accumulated: 0,
  someNewField: true,
};
const raw = Buffer.from(JSON.stringify(payload));
const sign = (timestamp: string, body: Buffer = raw, key = secret) =>
  `sha256=${createHmac('sha256', key).update(`${timestamp}.`).update(body).digest('hex')}`;
const nowSeconds = () => String(Math.floor(Date.now() / 1000));

function request(body: Buffer, headers: Record<string, string>, method = 'POST') {
  const stream = Readable.from([body]) as unknown as IncomingMessage & { body?: unknown };
  Object.assign(stream, { method, headers, socket: { remoteAddress: '10.0.0.' + Math.random() } });
  return stream;
}
function response() {
  const out: { statusCode?: number; body?: string; headers: Map<string, string> } = {
    headers: new Map(),
  };
  const res = {
    setHeader: (k: string, v: string) => out.headers.set(k, v),
    end: (v: string) => {
      out.body = v;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, 'statusCode', {
    set: (v: number) => (out.statusCode = v),
    get: () => out.statusCode,
  });
  return { res, out };
}

describe('SePay webhook signature', () => {
  it('accepts a fresh HMAC over timestamp.rawBody and rejects tampering, replay age or wrong key', () => {
    const ts = nowSeconds();
    expect(
      verifySepay({ 'x-sepay-signature': sign(ts), 'x-sepay-timestamp': ts }, raw, { secret }),
    ).toBe('hmac');
    expect(() =>
      verifySepay(
        { 'x-sepay-signature': sign(ts), 'x-sepay-timestamp': ts },
        Buffer.concat([raw, Buffer.from(' ')]),
        { secret },
      ),
    ).toThrow('Invalid signature');
    expect(() =>
      verifySepay(
        { 'x-sepay-signature': sign(ts, raw, 'x'.repeat(32)), 'x-sepay-timestamp': ts },
        raw,
        { secret },
      ),
    ).toThrow('Invalid signature');
    const old = String(Number(ts) - 301);
    expect(() =>
      verifySepay({ 'x-sepay-signature': sign(old), 'x-sepay-timestamp': old }, raw, { secret }),
    ).toThrow('Request expired');
    expect(() => verifySepay({}, raw, { secret })).toThrow('Invalid signature');
  });
  it('accepts the API-key mode only with the exact key', () => {
    expect(
      verifySepay({ authorization: 'Apikey ' + 'k'.repeat(32) }, raw, { apiKey: 'k'.repeat(32) }),
    ).toBe('apikey');
    expect(() =>
      verifySepay({ authorization: 'Apikey ' + 'k'.repeat(31) + 'x' }, raw, {
        apiKey: 'k'.repeat(32),
      }),
    ).toThrow('Invalid signature');
    expect(() =>
      verifySepay({ authorization: 'Bearer ' + 'k'.repeat(32) }, raw, { apiKey: 'k'.repeat(32) }),
    ).toThrow('Invalid signature');
  });
  it('ignores short or missing configuration', () => {
    expect(sepayConfig({})).toEqual({});
    expect(sepayConfig({ BANK_WEBHOOK_SEPAY_SECRET: 'short' })).toEqual({});
    expect(sepayConfig({ BANK_WEBHOOK_SEPAY_SECRET: ` ${secret} ` })).toEqual({ secret });
  });
});

describe('SePay payload', () => {
  it('maps the documented fields, tolerates unknown ones and normalizes numbers', () => {
    expect(parseSepayPayload(raw)).toEqual({
      provider: 'SEPAY',
      provider_transaction_id: '92704',
      transfer_type: 'IN',
      amount: '300000',
      content: payload.content,
      account_number: '0001234567',
      bank_gateway: 'Vietcombank',
      reference_code: 'FT26316ABC',
      sub_account: '',
      transaction_date: '2026-11-12 20:15:00',
      payload_json: raw.toString('utf8'),
    });
    expect(
      parseSepayPayload(Buffer.from(JSON.stringify({ ...payload, transferAmount: '0150000' })))
        .amount,
    ).toBe('150000');
    for (const change of [
      { transferType: 'sideways' },
      { transferAmount: 0 },
      { transferAmount: 1.5 },
      { id: 'abc' },
      { content: 42 },
    ])
      expect(
        () => parseSepayPayload(Buffer.from(JSON.stringify({ ...payload, ...change }))),
        JSON.stringify(change),
      ).toThrow();
    expect(() => parseSepayPayload(Buffer.from('[]'))).toThrow();
    expect(() => parseSepayPayload(Buffer.from('{'))).toThrow();
  });
  it('rate-limits a single source without affecting others', () => {
    const source = 'limit-test';
    for (let i = 0; i < 60; i++) expect(allowWebhookRequest(source, 1_000_000)).toBe(true);
    expect(allowWebhookRequest(source, 1_000_000)).toBe(false);
    expect(allowWebhookRequest('other', 1_000_000)).toBe(true);
    expect(allowWebhookRequest(source, 1_000_000 + 60_000)).toBe(true);
  });
});

describe('SePay webhook handler', () => {
  const url = new URL('http://localhost/api/v1/webhooks/bank/sepay');
  it('forwards a verified transfer to Finance and answers the success shape SePay expects', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ receipt_id: 'r', processing_status: 'MATCHED' }),
    };
    const ts = nowSeconds();
    const { res, out } = response();
    await handleBankWebhook(
      request(raw, { 'x-sepay-signature': sign(ts), 'x-sepay-timestamp': ts }),
      res,
      url,
      client,
      { secret },
    );
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body!)).toEqual({ success: true, receipt_id: 'r', status: 'MATCHED' });
    expect(client.call).toHaveBeenCalledWith(
      'ReceiveBankTransfer',
      expect.objectContaining({
        provider: 'SEPAY',
        provider_transaction_id: '92704',
        amount: '300000',
      }),
      expect.any(String),
    );
  });
  it('never reaches Finance for bad signatures, missing config, bad payloads or wrong methods', async () => {
    const client = { call: vi.fn() };
    const ts = nowSeconds();
    let r = response();
    await handleBankWebhook(
      request(raw, { 'x-sepay-signature': 'sha256=00', 'x-sepay-timestamp': ts }),
      r.res,
      url,
      client,
      { secret },
    );
    expect(r.out.statusCode).toBe(401);
    expect(JSON.parse(r.out.body!)).toEqual({ success: false, message: 'Invalid signature' });
    r = response();
    await handleBankWebhook(
      request(raw, { 'x-sepay-signature': sign(ts), 'x-sepay-timestamp': ts }),
      r.res,
      url,
      client,
      {},
    );
    expect(r.out.statusCode).toBe(503);
    r = response();
    const bad = Buffer.from('{"transferType":"in"}');
    await handleBankWebhook(
      request(bad, { 'x-sepay-signature': sign(ts, bad), 'x-sepay-timestamp': ts }),
      r.res,
      url,
      client,
      { secret },
    );
    expect(r.out.statusCode).toBe(400);
    r = response();
    await handleBankWebhook(request(raw, {}, 'GET'), r.res, url, client, { secret });
    expect(r.out.statusCode).toBe(404);
    expect(client.call).not.toHaveBeenCalled();
  });
  it('turns a Finance outage into a retryable failure instead of a false success', async () => {
    const client = {
      call: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 14 })),
    };
    const ts = nowSeconds();
    const { res, out } = response();
    await handleBankWebhook(
      request(raw, { 'x-sepay-signature': sign(ts), 'x-sepay-timestamp': ts }),
      res,
      url,
      client,
      { secret },
    );
    expect(out.statusCode).toBe(503);
  });
});

describe('bank transfer read projection', () => {
  it('publishes only masked, well-formed rows', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const row = {
      id,
      provider: 'SEPAY',
      provider_transaction_id: '92704',
      transfer_type: 'IN',
      amount: '300000',
      content: 'CK ABC',
      account_number_masked: '******4567',
      bank_gateway: 'Vietcombank',
      processing_status: 'MATCHED',
      contribution_id: id,
      received_at: { seconds: '1792000000', nanos: 0 },
    };
    expect(projectBankTransfer(row)).toMatchObject({
      id,
      processing_status: 'MATCHED',
      contribution_id: id,
      review_reason: null,
      transaction_at: null,
      processed_at: null,
    });
    expect(() => projectBankTransfer({ ...row, processing_status: 'DONE' })).toThrow();
    expect(() => projectBankTransfer({ ...row, amount: '0' })).toThrow();
    expect(bankRoute('/api/v1/webhooks/bank/sepay')).toEqual({
      kind: 'webhook',
      provider: 'sepay',
    });
    expect(bankRoute('/api/v1/webhooks/bank/other')).toBeUndefined();
    expect(bankRoute(`/api/v1/funds/${id}/bank-transfers`)).toEqual({ kind: 'list', fundId: id });
  });
});
