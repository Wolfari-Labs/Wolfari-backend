import { describe, expect, it } from 'vitest';
import { refundResponse } from './refund-response';
describe('refund response', () => {
  it('keeps exact money and omits internal audit fields', () => {
    const value = refundResponse(
      {
        id: '1',
        fund_id: '2',
        member_user_id: '3',
        amount: '9223372036854775807',
        status: 'PENDING',
        reason: 'Dư',
        requested_by_user_id: '4',
        holder_reported_at: null,
        confirmed_by_user_id: null,
        confirmed_at: null,
        cancelled_at: null,
        created_at: '2026-10-22T00:00:00.000Z',
        updated_at: '2026-10-22T00:00:00.000Z',
        version: 1,
        nonreceipt_confirmed_at: null,
        reversal_consented_at: null,
        reversal_requested_at: null,
        reversal_reason: null,
        cancelled_reason: null,
      },
      7,
    );
    expect(value).toMatchObject({
      amount: '9223372036854775807',
      finance_version: 7,
      holder_reported_at: undefined,
    });
    expect(value).not.toHaveProperty('requested_by_user_id');
    expect(value).not.toHaveProperty('reversal_reason');
  });
});
