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
        status: 'CONFIRMED',
        reason: 'Dư',
        requested_by_user_id: '4',
        holder_reported_at: null,
        confirmed_by_user_id: '4',
        confirmed_at: null,
        cancelled_at: null,
        created_at: '2026-10-22T00:00:00.000Z',
        updated_at: '2026-10-22T00:00:00.000Z',
        version: 1,
        nonreceipt_confirmed_at: null,
        reversal_consented_at: null,
        reversal_requested_at: null,
        reversal_reason: 'Yêu cầu đảo riêng',
        cancelled_reason: null,
        confirmation_mode: 'SELF_UNVERIFIED',
        independent_verification: false,
      },
      7,
    );
    expect(value).toMatchObject({
      amount: '9223372036854775807',
      finance_version: 7,
      holder_reported_at: undefined,
    });
    expect(value).not.toHaveProperty('requested_by_user_id');
    expect(value).toMatchObject({
      reversal_reason: 'Yêu cầu đảo riêng',
      reason: 'Dư',
      confirmed_by_user_id: '4',
      confirmation_mode: 'SELF_UNVERIFIED',
      independent_verification: false,
    });
  });
});
