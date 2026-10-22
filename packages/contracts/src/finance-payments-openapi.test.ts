import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  paymentRoute,
  projectPaymentAttempt,
  projectPaymentException,
} from '../../../apps/api-gateway/src/payment-http';

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/api/finance-payments.openapi.json'), 'utf8'),
);
const id = '10000000-0000-4000-8000-000000000001';

describe('Payment Sandbox OpenAPI', () => {
  it('documents API090-095 and resolves every local reference', () => {
    expect(Object.keys(document.paths)).toHaveLength(6);
    expect(
      Object.values(document.paths).flatMap((path) => Object.keys(path as object)),
    ).toHaveLength(6);
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        let target: unknown = document;
        for (const part of String(value.$ref).slice(2).split('/'))
          target = (target as Record<string, unknown>)[part];
        expect(target, String(value.$ref)).toBeDefined();
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(document);
  });

  it('matches the safe attempt and exception projections', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = (name: string) =>
      ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
    const attempt = projectPaymentAttempt({
      id,
      contribution_id: id,
      provider: 'MOMO_SANDBOX',
      environment: 'SANDBOX',
      amount: '50000000',
      currency: 'VND',
      status: 'PENDING',
      needs_reconciliation: false,
      payment_url: 'https://test-payment.momo.vn/mock/order',
      expires_at: { seconds: '1', nanos: 0 },
      created_at: { seconds: '1', nanos: 0 },
      updated_at: { seconds: '2', nanos: 0 },
    });
    const exception = projectPaymentException({
      id,
      payment_attempt_id: id,
      processing_status: 'NEEDS_REVIEW',
      review_reason: 'AMOUNT_MISMATCH',
      received_at: { seconds: '1', nanos: 0 },
    });
    const attemptSchema = schema('PaymentAttempt');
    const exceptionSchema = schema('PaymentException');
    expect(attemptSchema(attempt), JSON.stringify(attemptSchema.errors)).toBe(true);
    expect(exceptionSchema(exception), JSON.stringify(exceptionSchema.errors)).toBe(true);
    expect(attemptSchema({ ...attempt, provider_payload: { signature: 'private' } })).toBe(false);
    expect(exceptionSchema({ ...exception, signature: 'private' })).toBe(false);
  });

  it('keeps user writes and provider callbacks strict', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = (name: string) =>
      ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
    expect(
      schema('CreatePaymentAttemptInput')({
        provider: 'MOMO_SANDBOX',
        expected_version: 1,
        expected_finance_version: 2,
      }),
    ).toBe(true);
    expect(schema('ReconcilePaymentAttemptInput')({ reason: 'Đối soát' })).toBe(true);
    const resolveInput = schema('ResolvePaymentExceptionInput');
    expect(
      resolveInput({
        resolution: 'LINKED',
        linked_attempt_id: id,
        reason: 'Khớp giao dịch',
        expected_finance_version: 3,
      }),
    ).toBe(true);
    expect(
      resolveInput({
        resolution: 'NO_FINANCIAL_EFFECT',
        linked_attempt_id: id,
        reason: 'Không phát sinh tiền',
        expected_finance_version: 3,
      }),
    ).toBe(false);
    const ipn = schema('MomoIpnInput');
    expect(
      ipn({
        partnerCode: 'MOMO_TEST',
        orderId: 'WLF-order',
        requestId: 'request-1',
        amount: 1000,
        orderInfo: 'Wolfari contribution',
        orderType: 'momo_wallet',
        transId: 123456,
        resultCode: 0,
        message: 'Successful.',
        payType: 'qr',
        responseTime: 1792627200000,
        extraData: '',
        signature: 'a'.repeat(64),
      }),
      JSON.stringify(ipn.errors),
    ).toBe(true);
  });

  it('rejects extra route segments', () => {
    expect(paymentRoute(`/api/v1/payment-attempts/${id}/reconcile/extra`)).toBeUndefined();
  });
});
