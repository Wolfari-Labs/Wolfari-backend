import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PaymentRepository } from './payment.repository';
const fund = '10000000-0000-4000-8000-000000000001';
const oldHolder = '20000000-0000-4000-8000-000000000001';
const holder = '30000000-0000-4000-8000-000000000001';
const snapshot = {
  schema_version: 1,
  fund_id: fund,
  holder_user_id: oldHolder,
  destination_id: fund,
  destination_version: 1,
  confirmed_by_holder_at: '2026-11-12T00:00:00Z',
  destination_type: 'MOMO_SANDBOX',
  recipient: { momo_phone: '0900000000' },
};
function setup(patch: Record<string, unknown> = {}, posted = false) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("transaction_type='CONTRIBUTION'"))
        return {
          rows: posted ? [{ id: fund, fund_id: fund, direction: 'IN', amount: '1000' }] : [],
          rowCount: posted ? 1 : 0,
        };
      if (sql.startsWith('SELECT status FROM funds'))
        return { rows: [{ status: 'OPEN' }], rowCount: 1 };
      if (sql.includes('MAX(sequence)')) return { rows: [{ sequence: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const repository = new PaymentRepository(client as never);
  const internal = repository as unknown as {
    lockedAttempt: (...args: unknown[]) => Promise<unknown>;
    settleSuccess: (client: unknown, id: string, source: unknown) => Promise<boolean>;
  };
  vi.spyOn(internal, 'lockedAttempt').mockResolvedValue({
    id: fund,
    fund_id: fund,
    trip_id: fund,
    contribution_id: fund,
    holder_user_id: holder,
    status: 'PENDING',
    provider: 'MOMO_SANDBOX',
    environment: 'SANDBOX',
    request_status: 'OPEN',
    contribution_status: 'PENDING',
    contribution_version: 1,
    finance_version: 2,
    current_balance: '0',
    amount: '1000',
    destination_snapshot: snapshot,
    ...patch,
  });
  const run = (source = {}) =>
    internal.settleSuccess(client, fund, {
      transactionId: '123',
      correlation: fund,
      actor: null,
      system: 'MOMO',
      ...source,
    });
  return { client, run };
}
describe('Previous Holder provider settlement', () => {
  it('holds automatic success for review without a ledger entry when the destination Holder changed', async () => {
    const s = setup();
    expect(await s.run()).toBe(false);
    expect(
      s.client.query.mock.calls.some(([sql]) => sql.includes('PREVIOUS_HOLDER_REVIEW_REQUIRED')),
    ).toBe(true);
    expect(
      s.client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO fund_transactions')),
    ).toBe(false);
  });
  it('preserves unchanged-Holder automatic settlement', async () => {
    const s = setup({ holder_user_id: oldHolder });
    expect(await s.run()).toBe(true);
    expect(
      s.client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO fund_transactions')),
    ).toHaveLength(1);
  });
  it('settles only an explicit current-Holder acknowledgement and audits both Holder IDs', async () => {
    const s = setup();
    expect(
      await s.run({ actor: holder, system: null, previousHolderTransferConfirmed: true }),
    ).toBe(true);
    expect(
      s.client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO fund_transactions')),
    ).toHaveLength(1);
    const audit = s.client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO finance_audit_logs'),
    ) as unknown as [string, unknown[]];
    expect(JSON.parse(String(audit[1][9]))).toMatchObject({
      previous_holder_transfer_confirmed: true,
      previous_holder_user_id: oldHolder,
      current_holder_user_id: holder,
    });
    expect(String(audit[1][9])).not.toContain('0900000000');
    const denied = setup();
    expect(
      await denied.run({ actor: oldHolder, system: null, previousHolderTransferConfirmed: true }),
    ).toBe(false);
  });
  it('fails closed on malformed stored identity, even with acknowledgement', async () => {
    const s = setup({ destination_snapshot: {} });
    expect(
      await s.run({ actor: holder, system: null, previousHolderTransferConfirmed: true }),
    ).toBe(false);
    expect(
      s.client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO fund_transactions')),
    ).toBe(false);
  });
  it('keeps an already posted successful replay idempotent after Holder changes', async () => {
    const s = setup(
      { status: 'SUCCEEDED', provider_transaction_id: '123', contribution_status: 'CONFIRMED' },
      true,
    );
    expect(await s.run()).toBe(true);
    expect(
      s.client.query.mock.calls.some(
        ([sql]) =>
          sql.includes('INSERT INTO fund_transactions') ||
          sql.includes('needs_reconciliation=true'),
      ),
    ).toBe(false);
  });
});
