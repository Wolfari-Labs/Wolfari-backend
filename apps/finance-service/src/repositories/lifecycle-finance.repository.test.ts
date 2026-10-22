import { describe, expect, it, vi } from 'vitest';
import { LifecycleFinanceRepository } from './lifecycle-finance.repository';

const operationId = '10000000-0000-4000-8000-000000000001';
const actor = '10000000-0000-4000-8000-000000000002';
const tripId = '10000000-0000-4000-8000-000000000003';
const membershipId = '10000000-0000-4000-8000-000000000004';
const target = '10000000-0000-4000-8000-000000000005';
const fundId = '10000000-0000-4000-8000-000000000006';
const firstContribution = '10000000-0000-4000-8000-000000000007';
const secondContribution = '10000000-0000-4000-8000-000000000008';
const correlation = '10000000-0000-4000-8000-000000000009';
const now = new Date('2026-10-22T01:02:03.004Z');

const request = (scope: 'LEAVE_MEMBER' | 'REMOVE_MEMBER' = 'REMOVE_MEMBER') => ({
  operation_id: operationId,
  request_hash: 'a'.repeat(64),
  operation_type: scope,
  authorization_context: {
    actor: { actor_user_id: scope === 'LEAVE_MEMBER' ? target : actor },
    trip_id: tripId,
    context_revision: 3,
    active_user_ids: [actor, target],
    command_scope: scope,
  },
  membership_target: {
    membership_id: membershipId,
    user_id: target,
    reason: 'No longer joining the trip',
  },
});

function receipt(values: unknown[]) {
  return {
    operation_id: operationId,
    actor_user_id: values[1],
    command_scope: values[2],
    request_hash: values[3],
    status: values[4],
    response: JSON.parse(values[5] as string),
    completed_at: now,
  };
}

describe('lifecycle finance repository', () => {
  it('atomically waives all eligible PENDING contributions with one Finance version', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('SELECT * FROM command_receipts')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,holder_user_id'))
          return {
            rows: [{ id: fundId, holder_user_id: actor, status: 'OPEN', finance_version: 11 }],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id FROM finance_closures')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,status,version FROM contributions'))
          return {
            rows: [
              { id: firstContribution, status: 'PENDING', version: 2 },
              { id: secondContribution, status: 'PENDING', version: 5 },
            ],
            rowCount: 2,
          };
        if (sql.startsWith('SELECT id,contribution_id')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT payment_attempt_id')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,contribution_id FROM fund_transactions'))
          return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT reversal_of_id FROM fund_transactions'))
          return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT status,reversal_requested_at')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('UPDATE contributions SET'))
          return {
            rows: [
              { id: firstContribution, version: 3 },
              { id: secondContribution, version: 6 },
            ],
            rowCount: 2,
          };
        if (sql.startsWith('UPDATE funds SET')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO command_receipts'))
          return { rows: [receipt(values!)], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const db = { withTransaction: vi.fn((work) => work(client)) };
    const result = await new LifecycleFinanceRepository(db as never).execute(
      request(),
      correlation,
    );

    expect(result.outcome).toMatchObject({ status: 1, blocking_ids: [] });
    expect(calls.find((call) => call.sql.startsWith('UPDATE contributions SET'))?.values).toEqual([
      [firstContribution, secondContribution],
      fundId,
    ]);
    expect(calls.find((call) => call.sql.startsWith('UPDATE funds SET'))?.values).toEqual([
      fundId,
      12,
      11,
    ]);
    const audits = calls.filter((call) => call.sql.includes('INSERT INTO finance_audit_logs'));
    expect(audits).toHaveLength(2);
    expect(audits.map((call) => call.values?.slice(2, 7))).toEqual([
      ['REMOVE_MEMBER', firstContribution, 2, 3, correlation],
      ['REMOVE_MEMBER', secondContribution, 5, 6, correlation],
    ]);
    const events = calls.filter((call) => call.sql.includes('INSERT INTO outbox_events'));
    expect(events).toHaveLength(2);
    expect(events.every((call) => call.values?.[2] === 12)).toBe(true);
    expect(events.map((call) => JSON.parse(call.values?.[4] as string))).toEqual([
      {
        fund_id: fundId,
        trip_id: tripId,
        contribution_id: firstContribution,
        status: 'WAIVED',
        finance_version: 12,
      },
      {
        fund_id: fundId,
        trip_id: tripId,
        contribution_id: secondContribution,
        status: 'WAIVED',
        finance_version: 12,
      },
    ]);
  });

  it('rejects the whole operation before waiving when any contribution was reported', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        statements.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('SELECT * FROM command_receipts')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,holder_user_id'))
          return {
            rows: [{ id: fundId, holder_user_id: actor, status: 'OPEN', finance_version: 11 }],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id FROM finance_closures')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,status,version FROM contributions'))
          return {
            rows: [
              { id: firstContribution, status: 'PENDING', version: 2 },
              { id: secondContribution, status: 'TRANSFER_REPORTED', version: 5 },
            ],
            rowCount: 2,
          };
        if (sql.startsWith('SELECT id,contribution_id')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT payment_attempt_id')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT id,contribution_id FROM fund_transactions'))
          return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT reversal_of_id FROM fund_transactions'))
          return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT status,reversal_requested_at')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO command_receipts'))
          return { rows: [receipt(values!)], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const db = { withTransaction: vi.fn((work) => work(client)) };
    const result = await new LifecycleFinanceRepository(db as never).execute(
      request(),
      correlation,
    );

    expect(result.outcome).toMatchObject({
      status: 2,
      error_code: 'FINANCE_OBLIGATION_BLOCKED',
      blocking_ids: [],
    });
    expect(statements.some((sql) => sql.startsWith('UPDATE contributions'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('UPDATE funds'))).toBe(false);
    expect(statements.some((sql) => sql.includes('finance_audit_logs'))).toBe(false);
    expect(statements.some((sql) => sql.includes('outbox_events'))).toBe(false);
  });

  it('replays the durable receipt without reading mutable Fund obligations', async () => {
    const saved = {
      operation_id: operationId,
      actor_user_id: target,
      command_scope: 'LEAVE_MEMBER',
      request_hash: 'a'.repeat(64),
      status: 'COMMITTED',
      response: {
        version: 1,
        tripId,
        lifecycleTarget: { membershipId, userId: target },
      },
      completed_at: now,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('SELECT * FROM command_receipts')) return { rows: [saved], rowCount: 1 };
        throw new Error(`Unexpected mutable read: ${sql}`);
      }),
    };
    const db = { withTransaction: vi.fn((work) => work(client)) };

    await expect(
      new LifecycleFinanceRepository(db as never).execute(request('LEAVE_MEMBER'), correlation),
    ).resolves.toMatchObject({ outcome: { status: 1 } });
  });
});
