import { describe, expect, it } from 'vitest';
import {
  parseCreatePaymentAttemptInput,
  parseMomoWebhookInput,
  parsePaymentExceptionPage,
  parseResolvePaymentExceptionInput,
} from './payment.input';

describe('Payment input', () => {
  it('parses exact versioned payment intent and binds exception cursors to a Fund', () => {
    expect(
      parseCreatePaymentAttemptInput({
        provider: 'MOMO_SANDBOX',
        expected_version: 2,
        expected_finance_version: 3,
      }),
    ).toEqual({ provider: 'MOMO_SANDBOX', expectedVersion: 2, expectedFinanceVersion: 3 });
    const cursor = Buffer.from(
      JSON.stringify({ version: 1, fund: 'fund-a', at: '2026-10-22T00:00:00Z', id: 'row-a' }),
    ).toString('base64url');
    expect(parsePaymentExceptionPage({ fundId: 'fund-a', limit: 10, cursor }).after?.id).toBe(
      'row-a',
    );
    expect(() => parsePaymentExceptionPage({ fundId: 'fund-b', cursor })).toThrow();
  });
  it('enforces linked versus no-financial-effect resolution fields', () => {
    expect(
      parseResolvePaymentExceptionInput({
        resolution: 'LINKED',
        linked_attempt_id: 'attempt',
        reason: 'verified',
        expected_finance_version: 4,
      }),
    ).toMatchObject({ resolution: 'LINKED', linkedAttemptId: 'attempt' });
    expect(() =>
      parseResolvePaymentExceptionInput({
        resolution: 'NO_FINANCIAL_EFFECT',
        linked_attempt_id: 'attempt',
        reason: 'ignored',
        expected_finance_version: 4,
      }),
    ).toThrow();
  });
  it('preserves MoMo int64 fields as strings/bigints and rejects malformed signatures', () => {
    const raw = {
      partner_code: 'MOMO_TEST',
      order_id: 'WLF-order',
      request_id: 'request-1',
      amount: '9007199254740993',
      order_info: 'Contribution',
      order_type: 'momo_wallet',
      transaction_id: '9007199254740993',
      result_code: 0,
      message: 'Successful.',
      pay_type: 'qr',
      response_time: '1792627200000',
      extra_data: '',
      signature: 'a'.repeat(64),
    };
    expect(parseMomoWebhookInput(raw).amount).toBe(9_007_199_254_740_993n);
    expect(() => parseMomoWebhookInput({ ...raw, signature: 'bad' })).toThrow();
  });
});
