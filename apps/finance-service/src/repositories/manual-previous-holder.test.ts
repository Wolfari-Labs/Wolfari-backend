import { describe, expect, it, vi } from 'vitest';
import { ManualContributionRepository } from './manual-contribution.repository';
const fund = '10000000-0000-4000-8000-000000000001';
const oldHolder = '20000000-0000-4000-8000-000000000001';
const holder = '30000000-0000-4000-8000-000000000001';
const member = '40000000-0000-4000-8000-000000000001';
const snapshot = {
  schema_version: 1,
  fund_id: fund,
  holder_user_id: oldHolder,
  destination_id: fund,
  destination_version: 1,
  confirmed_by_holder_at: '2026-11-12T00:00:00Z',
  destination_type: 'VIETQR',
  recipient: { bank_code: 'VCB', account_number: '001', account_name: 'TEST' },
};
function setup(current = holder, stored: unknown = snapshot, report = false) {
  const row = {
    id: fund,
    request_id: fund,
    fund_id: fund,
    member_user_id: member,
    amount: '1000',
    status: report ? 'PENDING' : 'TRANSFER_REPORTED',
    version: 1,
    self_contribution: false,
    member_reported_at: null,
    confirmed_at: null,
    confirmed_by_user_id: null,
    waived_reason: null,
    cancelled_reason: null,
    rejected_reason: null,
    transfer_evidence_object_key: null,
    destination_snapshot: stored,
  };
  const client = {
    query: vi.fn(async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('SELECT holder_user_id'))
        return {
          rows: [
            { holder_user_id: current, status: 'OPEN', finance_version: 2, current_balance: '0' },
          ],
          rowCount: 1,
        };
      if (sql.startsWith('SELECT status FROM contribution_requests'))
        return { rows: [{ status: 'OPEN' }], rowCount: 1 };
      if (sql.includes('FROM contributions WHERE id=')) return { rows: [row], rowCount: 1 };
      if (sql.includes('MAX(sequence)')) return { rows: [{ sequence: '0' }], rowCount: 1 };
      if (sql.startsWith('UPDATE contributions'))
        return { rows: [{ ...row, status: args[1], version: 2 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const repo = new ManualContributionRepository({ bind: vi.fn() });
  const run = (flag?: true) =>
    repo.execute(
      client as never,
      {
        scope: report ? 'REPORT_TRANSFER' : 'CONFIRM_RECEIVED',
        operationId: fund,
        actor: report ? member : current,
        fundId: fund,
        tripId: fund,
        requestId: fund,
        contributionId: fund,
        body: {
          command: {
            action: report ? 'REPORT_TRANSFER' : 'CONFIRM_RECEIVED',
            expectedVersion: 1,
            expectedFinanceVersion: 2,
            ...(flag ? { previousHolderTransferConfirmed: flag } : {}),
          },
        },
      } as never,
      {
        actorUserId: report ? member : current,
        ownerUserId: holder,
        activeMemberUserIds: new Set([oldHolder, holder, member]),
        tripArchived: false,
      },
      fund,
    );
  return { run, client };
}
describe('Manual previous Holder receipt', () => {
  it('requires acknowledgement before posting to the new Holder ledger', async () => {
    const s = setup();
    await expect(s.run()).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(
      s.client.query.mock.calls.some(
        ([sql]) => sql.startsWith('INSERT') || sql.startsWith('UPDATE'),
      ),
    ).toBe(false);
    await expect(s.run(true)).resolves.toMatchObject({ contribution: { status: 'CONFIRMED' } });
    expect(
      s.client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO fund_transactions')),
    ).toHaveLength(1);
    const audit = s.client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO finance_audit_logs'),
    )!;
    expect(JSON.parse(String(audit[1][7]))).toMatchObject({
      previous_holder_transfer_confirmed: true,
      previous_holder_user_id: oldHolder,
      current_holder_user_id: holder,
    });
  });
  it('preserves the unchanged-Holder command without the new field', async () => {
    await expect(setup(oldHolder).run()).resolves.toMatchObject({
      contribution: { status: 'CONFIRMED' },
    });
  });
  it('lets members report transfers to a previous destination without booking money', async () => {
    const s = setup(holder, snapshot, true);
    await expect(s.run()).resolves.toMatchObject({ contribution: { status: 'TRANSFER_REPORTED' } });
    expect(
      s.client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO fund_transactions')),
    ).toBe(false);
  });
  it('rejects malformed immutable snapshot even when the new Holder acknowledges', async () => {
    await expect(setup(holder, {}).run(true)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
});
