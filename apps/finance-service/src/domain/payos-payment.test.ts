import { describe, expect, it } from 'vitest';
import {
  classifyPayosStatus,
  newPayosOrderCode,
  PAYOS_REFERENCE,
  payosDescription,
  payosWebhookPaid,
} from './payos-payment';
import { parseCreatePaymentAttemptInput } from '../inputs/payment.input';
import { encodePayosReturnToken, PAYOS_RETURN_PATH } from '@wolfari/common';

describe('payOS payment rules', () => {
  it('uses 12-digit order codes and short transfer content for every bank', () => {
    expect(String(newPayosOrderCode())).toMatch(/^[1-9]\d{11}$/);
    expect(newPayosOrderCode(() => 100_000_000_000)).toBe(100_000_000_000);
    const text = payosDescription(999_999_999_999);
    expect(text.length).toBeLessThanOrEqual(9);
    expect(text).toMatch(/^WF[0-9A-Z]+$/);
  });
  it('moves money only on PAID and leaves underpayment to the Holder', () => {
    expect(classifyPayosStatus('PAID')).toBe('SUCCEEDED');
    expect(classifyPayosStatus('PENDING')).toBe('PENDING');
    expect(classifyPayosStatus('PROCESSING')).toBe('PENDING');
    expect(classifyPayosStatus('EXPIRED')).toBe('EXPIRED');
    expect(classifyPayosStatus('CANCELLED')).toBe('FAILED');
    expect(classifyPayosStatus('FAILED')).toBe('FAILED');
    expect(classifyPayosStatus('UNDERPAID')).toBe('REVIEW');
    expect(payosWebhookPaid('00')).toBe(true);
    expect(payosWebhookPaid('01')).toBe(false);
    expect(PAYOS_REFERENCE.test('FT23020412345')).toBe(true);
    expect(PAYOS_REFERENCE.test('a b')).toBe(false);
  });
  it('accepts a return page only for payOS and only the Gateway page with an app link', () => {
    const page = `http://192.168.1.5:3100${PAYOS_RETURN_PATH}${encodePayosReturnToken('exp://192.168.1.5:8081/--/fund')}`;
    const base = { expected_version: 1, expected_finance_version: 2 };
    expect(parseCreatePaymentAttemptInput({ ...base, provider: 'PAYOS', return_url: page })).toEqual({
      provider: 'PAYOS',
      expectedVersion: 1,
      expectedFinanceVersion: 2,
      returnUrl: page,
    });
    expect(parseCreatePaymentAttemptInput({ ...base, provider: 'PAYOS', return_url: '' })).not.toHaveProperty(
      'returnUrl',
    );
    expect(() =>
      parseCreatePaymentAttemptInput({ ...base, provider: 'PAYOS', return_url: page }, true),
    ).toThrow();
    expect(() =>
      parseCreatePaymentAttemptInput({ ...base, provider: 'MOMO_SANDBOX', return_url: page }),
    ).toThrow();
    expect(() =>
      parseCreatePaymentAttemptInput({ ...base, provider: 'PAYOS', return_url: 'https://evil.example/x' }),
    ).toThrow();
    expect(() => parseCreatePaymentAttemptInput({ ...base, provider: 'VNPAY' })).toThrow();
    expect(parseCreatePaymentAttemptInput({ ...base, provider: 'MOMO_SANDBOX' })).toEqual({
      provider: 'MOMO_SANDBOX',
      expectedVersion: 1,
      expectedFinanceVersion: 2,
    });
  });
});
