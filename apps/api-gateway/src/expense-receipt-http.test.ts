import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { CorrelationMiddleware } from '@wolfari/common';
import { FinanceReceiptHttp, receiptRoute } from './finance-receipt-http';

const expense = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const path = `/api/v1/expenses/${expense}/receipt`;
function setup() {
  const session = vi.fn().mockResolvedValue({ user_id: actor });
  const client = {
    close: vi.fn(),
    callFile: vi.fn().mockResolvedValue({
      expense_id: expense,
      fund_id: actor,
      mime_type: 'image/png',
      size_bytes: 3,
      content: Buffer.from('png'),
    }),
  };
  const handler = new FinanceReceiptHttp(session, client);
  async function invoke(suffix = '', method = 'GET', extraHeaders = {}) {
    const request = Object.assign(new EventEmitter(), {
      method,
      headers: { authorization: 'Bearer token', 'x-correlation-id': actor, ...extraHeaders },
    });
    let body: unknown;
    const headers = new Map<string, unknown>();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 0,
      destroyed: false,
      setHeader: (key: string, value: unknown) => headers.set(key, value),
      writeHead(code: number, values: Record<string, unknown>) {
        this.statusCode = code;
        for (const [key, value] of Object.entries(values)) headers.set(key, value);
      },
      end: (value: unknown) => {
        body = value;
      },
    });
    await new Promise<void>((resolve, reject) =>
      new CorrelationMiddleware().use(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
        () => {
          void handler
            .handle(
              request as unknown as IncomingMessage,
              response as unknown as ServerResponse,
              new URL(path + suffix, 'http://localhost'),
              receiptRoute(path)!,
            )
            .then(resolve, reject);
        },
      ),
    );
    return { code: response.statusCode, headers, body };
  }
  return { session, client, invoke };
}

describe('Expense receipt HTTP', () => {
  it('downloads from expense identity and validated session with private binary headers', async () => {
    const s = setup();
    const result = await s.invoke('', 'GET', { 'x-user-id': expense });
    expect(result.code).toBe(200);
    expect(result.body).toEqual(Buffer.from('png'));
    expect(result.headers.get('Content-Type')).toBe('image/png');
    expect(result.headers.get('Content-Disposition')).toBe('attachment; filename="receipt.png"');
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(s.client.callFile).toHaveBeenCalledWith(
      'DownloadExpenseReceipt',
      { expense_id: expense, actor_user_id: actor },
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it('rejects query injection, read bodies, wrong verbs and absent sessions', async () => {
    const s = setup();
    expect((await s.invoke('?object_key=private')).code).toBe(400);
    expect((await s.invoke('?fund_id=' + actor)).code).toBe(400);
    expect((await s.invoke('', 'GET', { 'content-length': '2' })).code).toBe(400);
    expect((await s.invoke('', 'POST')).code).toBe(404);
    expect((await s.invoke('', 'GET', { authorization: '' })).code).toBe(401);
    expect(s.client.callFile).not.toHaveBeenCalled();
  });
  it.each([
    { expense_id: actor },
    { mime_type: 'text/html' },
    { size_bytes: 4 },
    { fund_id: 'invalid' },
    { size_bytes: 10 * 1024 * 1024 + 1 },
  ])('refuses mismatched or unsafe upstream file metadata %j', async (patch) => {
    const s = setup();
    s.client.callFile.mockResolvedValueOnce({
      expense_id: expense,
      fund_id: actor,
      mime_type: 'image/png',
      size_bytes: 3,
      content: Buffer.from('png'),
      ...patch,
    });
    expect((await s.invoke()).code).toBe(503);
  });
});
