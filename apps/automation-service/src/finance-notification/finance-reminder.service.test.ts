import { describe, expect, it, vi } from 'vitest';
import { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReminderService } from './finance-reminder.service';

const fund = '11111111-1111-4111-8111-111111111111';
const trip = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const member = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const due = new Date('2026-12-10T12:00:00Z');
const now = new Date('2026-12-09T13:00:00Z'); // 23 h before the deadline
const ts = (value: Date) => ({ seconds: String(value.getTime() / 1000), nanos: 0 });

function setup(context: () => Promise<FinanceV1.GetAutomationContextResponse>) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const row = {
    source_type: 'CONTRIBUTION_REQUEST',
    source_id: request,
    fund_id: fund,
    trip_id: trip,
    next_at: now,
    sent_count: 0,
    created_at: new Date('2026-12-01T00:00:00Z'),
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return { rows: sql.startsWith('UPDATE finance_reminder_schedules SET claim_owner') ? [row] : [] };
  });
  const db = { query, withTransaction: vi.fn(async (work: (c: unknown) => unknown) => work({ query })) };
  const client = {
    getSourceContext: vi.fn(context),
    getEligibility: vi.fn(async (ids: string[]) => ({
      recipients: ids.map((id) => ({ user_id: id, eligible: id === member })),
    })),
  };
  const service = new FinanceReminderService(
    db as never,
    client as never,
    { get: (key: string) => (key === 'AUTOMATION_FINANCE_NOTIFICATION_ENABLED' ? 'true' : undefined) } as never,
  );
  return { service, queries, client };
}
const open = {
  finance_version: 3,
  status: FinanceV1.FundStatus.FUND_STATUS_OPEN,
  eligible: true,
  due_at: ts(due),
  authorized_recipients: [{ user_id: member }, { user_id: other }],
};

describe('FinanceReminderService', () => {
  it('reminds eligible members once before the deadline and schedules the overdue check', async () => {
    const { service, queries, client } = setup(async () => open);
    await service.runOnce(now);
    expect(client.getSourceContext).toHaveBeenCalledWith(
      { fundId: fund, sourceType: 'CONTRIBUTION_REQUEST', sourceId: request },
      expect.any(String),
      expect.any(Number),
    );
    const inserts = queries.filter((q) => q.sql.includes('INSERT INTO notifications'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params).toEqual([
      member,
      trip,
      'CONTRIBUTION_DUE_SOON',
      'Sắp đến hạn góp quỹ',
      'Bạn còn một khoản góp sắp đến hạn. Mở chuyến đi để xem.',
      request,
      `finance-reminder:CONTRIBUTION_DUE_SOON:${request}:${member}:2026-12-09`,
    ]);
    const next = queries.find((q) => q.sql.includes('sent_count=sent_count+1'));
    expect(next!.params[3]).toEqual(new Date(due.getTime() + 3_600_000));
  });

  it('removes the schedule when the request closed, everyone paid or it is gone', async () => {
    for (const context of [
      async () => ({ ...open, eligible: false }),
      async () => ({ ...open, due_at: undefined, authorized_recipients: [] }),
      async () => {
        throw Object.assign(new Error('missing'), { code: 5 });
      },
    ]) {
      const { service, queries } = setup(context);
      await service.runOnce(now);
      expect(queries.some((q) => q.sql.startsWith('DELETE FROM finance_reminder_schedules'))).toBe(true);
      expect(queries.some((q) => q.sql.includes('INSERT INTO notifications'))).toBe(false);
    }
  });

  it('only moves the schedule while the reminder is not due yet', async () => {
    const { service, queries } = setup(async () => ({ ...open, due_at: ts(new Date('2026-12-20T12:00:00Z')) }));
    await service.runOnce(now);
    const moved = queries.find((q) => q.sql.includes('SET next_at=$4,claim_owner=NULL'));
    expect(moved!.params[3]).toEqual(new Date('2026-12-19T12:00:00Z'));
    expect(queries.some((q) => q.sql.includes('INSERT INTO notifications'))).toBe(false);
  });

  it('retries a Finance outage five minutes later without notifying', async () => {
    const { service, queries } = setup(async () => {
      throw Object.assign(new Error('down'), { code: 14 });
    });
    await service.runOnce(now);
    const moved = queries.find((q) => q.sql.includes('SET next_at=$4,claim_owner=NULL'));
    expect(moved!.params[3]).toEqual(new Date(now.getTime() + 5 * 60_000));
    expect(queries.some((q) => q.sql.includes('INSERT INTO notifications'))).toBe(false);
  });

  it('refuses a poll interval outside 200 ms - 1 h', () => {
    expect(
      () =>
        new FinanceReminderService(
          {} as never,
          {} as never,
          { get: (key: string) => (key === 'AUTOMATION_FINANCE_REMINDER_POLL_MS' ? '50' : undefined) } as never,
        ),
    ).toThrow();
  });
});
