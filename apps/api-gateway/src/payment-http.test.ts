import { describe, expect, it } from 'vitest';
import { paymentRoute, projectPaymentAttempt, projectPaymentException } from './payment-http';

const id = '10000000-0000-4000-8000-000000000001';
describe('Payment HTTP', () => {
  it('recognizes only the six exact Payment routes', () => {
    expect(paymentRoute(`/api/v1/contributions/${id}/payment-attempts`)).toEqual({
      kind: 'create',
      contributionId: id,
    });
    expect(paymentRoute(`/api/v1/payment-attempts/${id}`)).toMatchObject({
      kind: 'attempt',
      reconcile: false,
    });
    expect(paymentRoute(`/api/v1/payment-attempts/${id}/reconcile`)).toMatchObject({
      kind: 'attempt',
      reconcile: true,
    });
    expect(paymentRoute('/api/v1/webhooks/momo')).toEqual({ kind: 'webhook' });
    expect(paymentRoute(`/api/v1/funds/${id}/payment-exceptions`)).toMatchObject({
      kind: 'exceptions',
    });
    expect(paymentRoute(`/api/v1/payment-exceptions/${id}/resolve`)).toMatchObject({
      kind: 'resolve',
    });
    expect(paymentRoute(`/api/v1/payment-attempts/${id}/reconcile/extra`)).toBeUndefined();
  });
  it('fails closed on unsafe provider URLs and omits raw exception fields', () => {
    const base = {
      id,
      contribution_id: id,
      provider: 'MOMO_SANDBOX',
      environment: 'SANDBOX',
      amount: '1000',
      currency: 'VND',
      status: 'PENDING',
      needs_reconciliation: false,
      created_at: { seconds: '1', nanos: 0 },
      updated_at: { seconds: '1', nanos: 0 },
    };
    expect(() =>
      projectPaymentAttempt({ ...base, payment_url: 'https://evil.test/pay' }),
    ).toThrow();
    expect(
      projectPaymentException({
        id,
        payment_attempt_id: id,
        processing_status: 'NEEDS_REVIEW',
        review_reason: 'AMOUNT_MISMATCH',
        received_at: { seconds: '1', nanos: 0 },
        payload: { signature: 'private' },
      }),
    ).not.toHaveProperty('payload');
  });
});
