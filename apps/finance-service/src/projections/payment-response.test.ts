import { describe, expect, it } from 'vitest';
import { paymentAttemptResponse, paymentExceptionResponse } from './payment-response';

const id = '10000000-0000-4000-8000-000000000001';
describe('Payment public projections', () => {
  it('whitelists a payment URL and omits provider payload/secrets', () => {
    const result = paymentAttemptResponse({
      id,
      contribution_id: id,
      provider: 'MOMO_SANDBOX',
      environment: 'SANDBOX',
      amount: '1000',
      currency: 'VND',
      status: 'PENDING',
      provider_payload: {
        payment_url: 'https://test-payment.momo.vn/mock/order',
        signature: 'private',
      },
      needs_reconciliation: false,
      expires_at: null,
      error_code: null,
      created_at: new Date('2026-10-22T00:00:00Z'),
      updated_at: new Date('2026-10-22T00:00:00Z'),
    });
    expect(result.payment_url).toContain('test-payment.momo.vn');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('never exposes raw webhook payload in exception views', () => {
    const result = paymentExceptionResponse({
      id,
      payment_attempt_id: id,
      processing_status: 'NEEDS_REVIEW',
      review_reason: 'AMOUNT_MISMATCH',
      received_at: new Date('2026-10-22T00:00:00Z'),
      reviewed_at: null,
    });
    expect(result).toMatchObject({ id, review_reason: 'AMOUNT_MISMATCH' });
    expect(result).not.toHaveProperty('payload');
  });
});
