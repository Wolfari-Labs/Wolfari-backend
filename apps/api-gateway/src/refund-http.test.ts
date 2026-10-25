import { describe, expect, it } from 'vitest';
import { projectRefund, refundRoute } from './refund-http';
const id = '10000000-0000-4000-8000-000000000001';
describe('refund HTTP projection', () => {
  it('recognizes all API111-119 routes', () => {
    expect(refundRoute(`/api/v1/funds/${id}/refunds`)).toEqual({ kind: 'collection', fundId: id });
    for (const action of [
      'report-paid',
      'confirm-received',
      'confirm-nonreceipt',
      'cancel',
      'request-reversal',
      'consent-reversal',
      'reverse',
    ])
      expect(refundRoute(`/api/v1/refunds/${id}/${action}`)).toEqual({
        kind: 'item',
        refundId: id,
        action,
      });
  });
  it('projects exact money and nullable public timestamps', () => {
    expect(
      projectRefund({
        id,
        fund_id: id,
        member_user_id: id,
        amount: '9223372036854775807',
        status: 'PENDING',
        reason: 'Dư',
        created_at: { seconds: '0', nanos: 0 },
        updated_at: { seconds: '0', nanos: 0 },
        version: 1,
        finance_version: 2,
      }),
    ).toMatchObject({
      amount: '9223372036854775807',
      holder_reported_at: null,
      finance_version: 2,
    });
  });
  it('rejects private or malformed response values', () => {
    expect(() =>
      projectRefund({
        id,
        fund_id: id,
        member_user_id: id,
        amount: '0',
        status: 'PENDING',
        reason: 'Dư',
        created_at: { seconds: '0', nanos: 0 },
        updated_at: { seconds: '0', nanos: 0 },
        version: 1,
        finance_version: 2,
      }),
    ).toThrow();
  });
});
