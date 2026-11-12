import { describe, expect, it, vi } from 'vitest';
import { ExpenseRepository } from './expense.repository';
import { ClosureRepository } from './closure.repository';
import { LifecycleFinanceRepository } from './lifecycle-finance.repository';

const fund = '10000000-0000-4000-8000-000000000001';
const trip = '10000000-0000-4000-8000-000000000002';
const owner = '10000000-0000-4000-8000-000000000003';
const next = '10000000-0000-4000-8000-000000000004';
const operation = '10000000-0000-4000-8000-000000000005';
const authority = {
  actorUserId: owner,
  ownerUserId: owner,
  activeMemberUserIds: new Set([owner, next]),
  tripArchived: false,
};

describe('handover guards in financial writers', () => {
  it.each(['CREATE_EXPENSE', 'SUBMIT_EXPENSE', 'UPDATE_EXPENSE'] as const)(
    'blocks %s under the Fund lock before any expense mutation',
    async (scope) => {
      const calls: { sql: string; values?: unknown[] }[] = [];
      const client = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          if (sql.includes('FROM funds'))
            return {
              rows: [
                {
                  id: fund,
                  holder_user_id: owner,
                  status: 'OPEN',
                  finance_version: 3,
                  current_balance: '100000',
                },
              ],
            };
          if (sql.includes('FROM fund_holder_handovers')) return { rows: [{ id: operation }] };
          throw new Error('Unexpected write after handover guard');
        }),
      };
      await expect(
        new ExpenseRepository(client as never).execute(
          client as never,
          {
            scope,
            operationId: operation,
            actor: owner,
            tripId: trip,
            fundId: fund,
            expenseId: operation,
            hash: 'a'.repeat(64),
            body: { amount: 1n, expectedFinanceVersion: 3 },
          } as never,
          authority,
          operation,
        ),
      ).rejects.toThrow('STATE_CONFLICT');
      expect(calls).toHaveLength(2);
      expect(calls[0]?.sql).toContain('FOR UPDATE');
      expect(calls[1]?.values).toEqual([fund, ['ACCEPTED']]);
    },
  );

  it('blocks closure even for a merely nominated handover before capturing a snapshot', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('FROM funds'))
          return {
            rows: [
              {
                id: fund,
                trip_id: trip,
                holder_user_id: owner,
                status: 'OPEN',
                finance_version: 3,
                current_balance: '0',
              },
            ],
          };
        if (sql.includes('FROM fund_holder_handovers')) return { rows: [{ id: operation }] };
        throw new Error('Unexpected query after closure handover guard');
      }),
    };
    await expect(
      new ClosureRepository(client as never).execute(
        client as never,
        {
          scope: 'CREATE_CLOSURE',
          operationId: operation,
          actor: owner,
          tripId: trip,
          fundId: fund,
          hash: 'a'.repeat(64),
          body: { expectedFinanceVersion: 3 },
        } as never,
        authority,
        operation,
      ),
    ).rejects.toThrow('STATE_CONFLICT');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain('FOR UPDATE');
    expect(calls[1]?.values).toEqual([fund, ['NOMINATED', 'ACCEPTED']]);
  });

  it('blocks departure of the incoming Holder before waiving contributions', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT id,holder_user_id'))
          return {
            rows: [{ id: fund, holder_user_id: owner, status: 'OPEN', finance_version: 3 }],
            rowCount: 1,
          };
        if (sql.includes('FROM fund_holder_handovers'))
          return { rows: [{ id: operation }], rowCount: 1 };
        if (sql.startsWith('SELECT id,status,version FROM contributions'))
          return { rows: [{ id: operation, status: 'PENDING', version: 1 }], rowCount: 1 };
        if (sql.includes('INSERT INTO command_receipts'))
          return {
            rows: [
              {
                operation_id: operation,
                actor_user_id: values![1],
                command_scope: values![2],
                request_hash: values![3],
                status: values![4],
                response: JSON.parse(values![5] as string),
                completed_at: new Date(),
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      }),
    };
    const db = { withTransaction: vi.fn((work) => work(client)) };
    const result = await new LifecycleFinanceRepository(db as never).execute(
      {
        operation_id: operation,
        request_hash: 'a'.repeat(64),
        operation_type: 'LEAVE_MEMBER',
        authorization_context: {
          actor: { actor_user_id: next },
          trip_id: trip,
          context_revision: 3,
          active_user_ids: [owner, next],
          command_scope: 'LEAVE_MEMBER',
        },
        membership_target: { membership_id: next, user_id: next, reason: 'Leaving' },
      },
      operation,
    );
    expect(result.outcome?.error_code).toBe('FINANCE_OBLIGATION_BLOCKED');
    const lockIndex = calls.findIndex((call) => call.sql.startsWith('SELECT id,holder_user_id'));
    const handoverIndex = calls.findIndex((call) =>
      call.sql.includes('FROM fund_holder_handovers'),
    );
    expect(calls[lockIndex]?.sql).toContain('FOR UPDATE');
    expect(handoverIndex).toBeGreaterThan(lockIndex);
    expect(calls[handoverIndex]?.values).toEqual([fund, next]);
    expect(calls.some((call) => call.sql.startsWith('UPDATE contributions'))).toBe(false);
    expect(calls.some((call) => call.sql.startsWith('UPDATE funds'))).toBe(false);
  });
});
