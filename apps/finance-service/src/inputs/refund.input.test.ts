import { describe, expect, it } from 'vitest';
import {
  parseCreateRefund,
  parseRefundAction,
  parseRefundPage,
  parseRefundReasonAction,
  refundCursor,
} from './refund.input';

const fund = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const refund = '10000000-0000-4000-8000-000000000003';
describe('refund input', () => {
  it('normalizes exact int64 money, UUID and reason', () => {
    expect(
      parseCreateRefund({
        member_user_id: member,
        amount: '009007199254740993',
        reason: '  Hoàn phần dư  ',
        expected_finance_version: 4,
      }),
    ).toEqual({
      memberUserId: member,
      amount: 9007199254740993n,
      reason: 'Hoàn phần dư',
      expectedFinanceVersion: 4,
    });
  });
  it.each([
    { member_user_id: member, amount: '0', reason: 'x', expected_finance_version: 1 },
    {
      member_user_id: member,
      amount: '9223372036854775808',
      reason: 'x',
      expected_finance_version: 1,
    },
    { member_user_id: member, amount: '1', reason: 'x\0y', expected_finance_version: 1 },
    { member_user_id: member, amount: '1', reason: 'x', expected_finance_version: 1, extra: true },
  ])('rejects invalid create %#', (value) => expect(() => parseCreateRefund(value)).toThrow());
  it('parses strict action versions and reasons', () => {
    expect(parseRefundAction({ expected_version: 2, expected_finance_version: 5 })).toEqual({
      expectedVersion: 2,
      expectedFinanceVersion: 5,
    });
    expect(
      parseRefundReasonAction({
        reason: '  Chưa nhận  ',
        expected_version: 2,
        expected_finance_version: 5,
      }),
    ).toEqual({ reason: 'Chưa nhận', expectedVersion: 2, expectedFinanceVersion: 5 });
    expect(() => parseRefundAction({ expected_version: 0, expected_finance_version: 5 })).toThrow();
  });
  it('binds microsecond cursors to Fund and status', () => {
    const cursor = refundCursor(
      { fundId: fund, status: 'PENDING' },
      { at: '2026-10-22T01:02:03.123456Z', id: refund },
    );
    expect(parseRefundPage({ fund_id: fund, status: 'PENDING', cursor }).after?.at).toContain(
      '123456',
    );
    expect(() => parseRefundPage({ fund_id: fund, status: 'CONFIRMED', cursor })).toThrow();
  });
});
