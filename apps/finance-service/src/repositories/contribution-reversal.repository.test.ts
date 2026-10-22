import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { ContributionReversalRepository } from './contribution-reversal.repository';

const id = '10000000-0000-4000-8000-000000000001';
const originalId = '20000000-0000-4000-8000-000000000001';
const contribution = {
  id,
  request_id: id,
  fund_id: id,
  member_user_id: '30000000-0000-4000-8000-000000000001',
  amount: '300000',
  status: 'CONFIRMED',
  self_contribution: false,
  version: 2,
  member_reported_at: new Date('2026-10-20T00:00:00Z'),
  confirmed_at: new Date('2026-10-20T00:01:00Z'),
  confirmed_by_user_id: id,
  waived_reason: null,
  cancelled_reason: null,
};
const input = {
  scope: 'REVERSE_CONTRIBUTION' as const,
  operationId: id,
  actor: id,
  tripId: id,
  fundId: id,
  requestId: id,
  contributionId: id,
  hash: 'a'.repeat(64),
  body: { reason: 'Recorded twice', expectedVersion: 2, expectedFinanceVersion: 5 },
};
const authority = {
  actorUserId: id,
  ownerUserId: '40000000-0000-4000-8000-000000000001',
  activeMemberUserIds: new Set([id]),
  tripArchived: false,
};

function clientWith(refundAmount = '100000', originalAmount = '300000') {
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT holder_user_id'))
      return {
        rows: [
          { holder_user_id: id, status: 'OPEN', finance_version: 5, current_balance: '400000' },
        ],
      };
    if (sql.startsWith('SELECT status FROM contribution_requests'))
      return { rows: [{ status: 'OPEN' }] };
    if (sql.includes('FROM contributions WHERE') && sql.startsWith('SELECT'))
      return { rows: [{ ...contribution }] };
    if (sql.includes('FROM payment_attempts')) return { rows: [] };
    if (sql.includes('contribution_id=$2 ORDER BY id'))
      return {
        rows: [{ id: originalId, direction: 'IN ', amount: originalAmount, reversal_of_id: null }],
      };
    if (sql.includes('WHERE reversal_of_id=$1')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM fund_refunds'))
      return { rows: [{ amount: refundAmount, status: 'PENDING' }] };
    if (sql.includes('COALESCE(MAX(sequence)')) return { rows: [{ sequence: '8' }] };
    if (sql.startsWith("UPDATE contributions SET status='REVERSED'"))
      return { rows: [{ ...contribution, status: 'REVERSED', version: 3 }] };
    return { rows: [], rowCount: 1, args };
  });
  return { query };
}

describe('Contribution reversal repository', () => {
  it('writes one exact OUT reversal and keeps the public confirmation history', async () => {
    const client = clientWith();
    const result = await new ContributionReversalRepository().execute(
      client as unknown as Pick<DatabaseProvider, 'query'>,
      input,
      authority,
      id,
    );
    expect(result.contribution).toMatchObject({
      id,
      status: 'REVERSED',
      version: 3,
      finance_version: 6,
      amount: '300000',
    });
    expect(result.contribution?.confirmed_at).toBeDefined();
    const ledger = client.query.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO fund_transactions'),
    );
    expect(ledger?.[1]).toEqual([
      expect.any(String),
      id,
      '9',
      '300000',
      '100000',
      originalId,
      id,
      'Recorded twice',
      `reversal:contribution:${id}`,
    ]);
    const event = client.query.mock.calls.find(([sql]) => String(sql).includes('outbox_events'));
    expect(String(event?.[1]?.[4])).toContain('"status":"REVERSED"');
    expect(String(event?.[1]?.[4])).not.toContain('Recorded twice');
  });

  it('rejects spending money reserved for refunds before any insert', async () => {
    const client = clientWith('100001');
    await expect(
      new ContributionReversalRepository().execute(
        client as unknown as Pick<DatabaseProvider, 'query'>,
        input,
        authority,
        id,
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).startsWith('INSERT INTO fund_transactions'),
      ),
    ).toBe(false);
  });

  it('fails closed when the stored ledger amount disagrees with the confirmed contribution', async () => {
    const client = clientWith('0', '299999');
    await expect(
      new ContributionReversalRepository().execute(
        client as unknown as Pick<DatabaseProvider, 'query'>,
        input,
        authority,
        id,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
