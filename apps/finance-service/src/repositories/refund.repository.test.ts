import { describe, expect, it, vi } from 'vitest';
import { RefundRepository } from './refund.repository';
import type { FundWrite } from './fund-command.repository';

const fundId = '10000000-0000-4000-8000-000000000001',
  tripId = '10000000-0000-4000-8000-000000000002',
  owner = '10000000-0000-4000-8000-000000000003',
  holder = '10000000-0000-4000-8000-000000000004',
  recipient = '10000000-0000-4000-8000-000000000005',
  refundId = '10000000-0000-4000-8000-000000000006',
  ledgerId = '10000000-0000-4000-8000-000000000007';
const now = new Date('2026-10-22T01:02:03.004Z');
const base = {
  id: refundId,
  fund_id: fundId,
  member_user_id: recipient,
  amount: '100000',
  status: 'HOLDER_REPORTED',
  reason: 'Dư',
  requested_by_user_id: owner,
  holder_reported_at: now,
  confirmed_by_user_id: null,
  confirmed_at: null,
  cancelled_at: null,
  created_at: now,
  updated_at: now,
  version: 2,
  nonreceipt_confirmed_at: null,
  reversal_consented_at: null,
  reversal_requested_at: null,
  reversal_reason: null,
  cancelled_reason: null,
};
const authority = (actor: string) => ({
  actorUserId: actor,
  ownerUserId: owner,
  activeMemberUserIds: new Set([owner, holder, recipient]),
  tripArchived: false,
});
const command = (actor: string) => ({
  operationId: ledgerId,
  actor,
  tripId,
  fundId,
  refundId,
  hash: 'a'.repeat(64),
});
describe('refund repository', () => {
  it('confirms receipt by releasing its reservation and appending one REFUND OUT', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 8,
                holder_user_id: holder,
                current_balance: '300000',
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id,fund_id,member_user_id'))
          return { rows: [base], rowCount: 1 };
        if (sql.startsWith('SELECT id,amount::text,status'))
          return {
            rows: [
              { id: refundId, amount: '100000', status: 'HOLDER_REPORTED' },
              { id: '10000000-0000-4000-8000-000000000008', amount: '200000', status: 'PENDING' },
            ],
            rowCount: 2,
          };
        if (sql.startsWith('SELECT COALESCE(MAX(sequence)'))
          return { rows: [{ sequence: '4' }], rowCount: 1 };
        if (sql.includes('INSERT INTO fund_transactions'))
          return { rows: [{ id: ledgerId }], rowCount: 1 };
        if (sql.includes("UPDATE fund_refunds SET status='CONFIRMED'"))
          return {
            rows: [
              {
                ...base,
                status: 'CONFIRMED',
                confirmed_by_user_id: recipient,
                confirmed_at: now,
                version: 3,
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      }),
    };
    const result = await new RefundRepository(client as never).execute(
      client as never,
      {
        ...command(recipient),
        scope: 'CONFIRM_REFUND_RECEIVED',
        body: { expectedVersion: 2, expectedFinanceVersion: 8 },
      } as FundWrite & { scope: 'CONFIRM_REFUND_RECEIVED' },
      authority(recipient),
      ledgerId,
    );
    expect(result.refund).toMatchObject({ status: 'CONFIRMED', finance_version: 9, version: 3 });
    expect(calls.find((x) => x.sql.includes('INSERT INTO fund_transactions'))?.values).toEqual([
      fundId,
      '5',
      '100000',
      '200000',
      refundId,
      recipient,
      `refund:${refundId}`,
    ]);
    expect(calls.find((x) => x.sql.includes('UPDATE funds SET current_balance'))?.values).toEqual([
      fundId,
      '200000',
      9,
    ]);
  });
  it('does not move money when recipient confirms nonreceipt', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 8,
                holder_user_id: holder,
                current_balance: '300000',
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id,fund_id,member_user_id'))
          return { rows: [base], rowCount: 1 };
        if (sql.includes('SET nonreceipt_confirmed_at'))
          return { rows: [{ ...base, nonreceipt_confirmed_at: now, version: 3 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const result = await new RefundRepository(client as never).execute(
      client as never,
      {
        ...command(recipient),
        scope: 'CONFIRM_REFUND_NONRECEIPT',
        body: { reason: 'Chưa nhận', expectedVersion: 2, expectedFinanceVersion: 8 },
      } as FundWrite & { scope: 'CONFIRM_REFUND_NONRECEIPT' },
      authority(recipient),
      ledgerId,
    );
    expect(result.refund).toMatchObject({
      status: 'HOLDER_REPORTED',
      version: 3,
      finance_version: 9,
    });
    expect(statements.some((sql) => sql.includes('INSERT INTO fund_transactions'))).toBe(false);
    expect(statements.some((sql) => sql.includes('SET current_balance'))).toBe(false);
  });
  it('reverses only the exact REFUND OUT with one linked IN', async () => {
    const confirmed = {
      ...base,
      status: 'CONFIRMED',
      confirmed_by_user_id: recipient,
      confirmed_at: now,
      version: 5,
      reversal_requested_at: now,
      reversal_consented_at: now,
      reversal_reason: 'Trả nhầm',
    };
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 11,
                holder_user_id: holder,
                current_balance: '200000',
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id,fund_id,member_user_id'))
          return { rows: [confirmed], rowCount: 1 };
        if (sql.includes('WHERE fund_id=$1 AND refund_id=$2'))
          return {
            rows: [
              {
                id: ledgerId,
                direction: 'OUT',
                transaction_type: 'REFUND',
                amount: '100000',
                reversal_of_id: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id FROM fund_transactions')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,amount::text,status'))
          return { rows: [{ id: refundId, amount: '100000', status: 'CONFIRMED' }], rowCount: 1 };
        if (sql.startsWith('SELECT COALESCE(MAX(sequence)'))
          return { rows: [{ sequence: '5' }], rowCount: 1 };
        if (sql.includes('INSERT INTO fund_transactions'))
          return { rows: [{ id: '10000000-0000-4000-8000-000000000009' }], rowCount: 1 };
        if (sql.includes("UPDATE fund_refunds SET status='REVERSED'"))
          return { rows: [{ ...confirmed, status: 'REVERSED', version: 6 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const result = await new RefundRepository(client as never).execute(
      client as never,
      {
        ...command(holder),
        scope: 'REVERSE_REFUND',
        body: { reason: 'Trả nhầm', expectedVersion: 5, expectedFinanceVersion: 11 },
      } as FundWrite & { scope: 'REVERSE_REFUND' },
      authority(holder),
      ledgerId,
    );
    expect(result.refund).toMatchObject({ status: 'REVERSED', finance_version: 12 });
    expect(calls.find((x) => x.sql.includes('INSERT INTO fund_transactions'))?.values).toEqual([
      fundId,
      '6',
      '100000',
      '300000',
      ledgerId,
      holder,
      'Trả nhầm',
      `reversal:refund:${refundId}`,
    ]);
  });
});
