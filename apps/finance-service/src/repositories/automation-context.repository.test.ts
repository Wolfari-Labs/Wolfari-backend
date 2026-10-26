import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FinanceAutomationContextRepository,
  type AutomationSourceType,
} from './automation-context.repository';

const fundId = '10000000-0000-4000-8000-000000000001';
const tripId = '20000000-0000-4000-8000-000000000001';
const sourceId = '30000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000001';
function row() {
  return {
    fund_id: fundId,
    trip_id: tripId,
    finance_version: 8,
    fund_status: 'OPEN',
    source_id: sourceId,
    source_status: 'PENDING',
    source_version: 2,
    request_status: 'OPEN',
    request_version: 3,
    due_at: new Date('2026-11-01T02:00:00.123Z'),
    source_consistent: true,
    candidates: [{ user_id: userId, cutoff_micros: '1792886400123456' }],
  };
}
function setup(rows: unknown[] = [row()]) {
  const query = vi.fn().mockImplementation(async (text: string) => ({
    rows: text.startsWith('SELECT f.') ? rows : [],
  }));
  const database = { withTransaction: vi.fn().mockImplementation((work) => work({ query })) };
  return { query, database, repository: new FinanceAutomationContextRepository(database) };
}
const deadline = () => Date.now() + 5000;
afterEach(() => vi.restoreAllMocks());

describe('Finance Automation source snapshots', () => {
  it('reads a minimal stable source snapshot in a short read-only transaction', async () => {
    const s = setup();
    expect(await s.repository.find(fundId, 'CONTRIBUTION_DUE', sourceId, deadline())).toEqual({
      fundId,
      tripId,
      financeVersion: 8,
      fundStatus: 'OPEN',
      sourceType: 'CONTRIBUTION_DUE',
      sourceId,
      sourceStatus: 'PENDING',
      sourceVersion: 2,
      requestStatus: 'OPEN',
      requestVersion: 3,
      dueAt: '2026-11-01T02:00:00.123Z',
      eligible: true,
      candidates: [{ userId, cutoffMicros: '1792886400123456' }],
    });
    expect(s.query.mock.calls[0]).toEqual(['SET TRANSACTION READ ONLY']);
    expect(s.query.mock.calls[1]?.[0]).toContain("set_config('statement_timeout'");
    expect(Number(s.query.mock.calls[1]?.[1]?.[0])).toBeGreaterThan(0);
    expect(s.query.mock.calls[2]?.[1]).toEqual([fundId, sourceId]);
    for (const forbidden of [
      'destination_snapshot',
      'account_number',
      'snapshot_json',
      'receipt_object_key',
      'provider_payload',
    ])
      expect(s.query.mock.calls[2]?.[0]).not.toContain(forbidden);
    expect(s.database.withTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CONTRIBUTION_REQUEST', 'OPEN', 'OPEN', 'OPEN', true],
    ['CONTRIBUTION_REQUEST', 'OPEN', 'CANCELLED', 'CANCELLED', false],
    ['CONTRIBUTION_DUE', 'OPEN', 'PENDING', 'OPEN', true],
    ['CONTRIBUTION_DUE', 'OPEN', 'TRANSFER_REPORTED', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'OPEN', 'CONFIRMED', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'OPEN', 'WAIVED', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'OPEN', 'CANCELLED', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'OPEN', 'REVERSED', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'CLOSING', 'PENDING', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'CLOSED', 'PENDING', 'OPEN', false],
    ['CONTRIBUTION_DUE', 'OPEN', 'PENDING', 'CLOSED', false],
    ['CONTRIBUTION_REVIEW', 'OPEN', 'TRANSFER_REPORTED', 'OPEN', true],
    ['CONTRIBUTION_REVIEW', 'OPEN', 'PENDING', 'OPEN', false],
    ['CONTRIBUTION_REVIEW', 'OPEN', 'CONFIRMED', 'OPEN', false],
    ['CLOSURE', 'CLOSING', 'PENDING_CONFIRMATIONS', null, true],
    ['CLOSURE', 'OPEN', 'PENDING_CONFIRMATIONS', null, false],
    ['CLOSURE', 'CLOSING', 'CANCELLED', null, false],
    ['CLOSURE', 'CLOSED', 'COMPLETED', null, false],
  ])(
    'keeps %s purpose for Fund %s/source %s/request %s',
    async (type, fundStatus, sourceStatus, requestStatus, eligible) => {
      const stored = {
        ...row(),
        fund_status: fundStatus,
        source_status: sourceStatus,
        request_status: requestStatus,
        request_version: type === 'CLOSURE' ? null : 3,
        due_at: type === 'CLOSURE' ? null : row().due_at,
        candidates: [
          {
            user_id: userId,
            cutoff_micros: type === 'CONTRIBUTION_REVIEW' ? null : '1792886400123456',
          },
        ],
      };
      const s = setup([stored]);
      const result = await s.repository.find(
        fundId,
        type as AutomationSourceType,
        sourceId,
        deadline(),
      );
      expect(result?.eligible).toBe(eligible);
      expect(result?.candidates).toHaveLength(eligible ? 1 : 0);
    },
  );

  it('distinguishes a missing source from an existing source with no pending candidates', async () => {
    const missing = setup([]);
    expect(
      await missing.repository.find(fundId, 'CONTRIBUTION_DUE', sourceId, deadline()),
    ).toBeNull();
    const empty = setup([{ ...row(), candidates: [] }]);
    expect(
      await empty.repository.find(fundId, 'CONTRIBUTION_DUE', sourceId, deadline()),
    ).toMatchObject({ eligible: true, candidates: [] });
  });

  it.each([
    { fund_id: tripId },
    { source_id: tripId },
    { trip_id: 'invalid' },
    { finance_version: 0 },
    { source_version: 0 },
    { source_status: 'UNKNOWN' },
    { request_status: 'UNKNOWN' },
    { due_at: new Date(NaN) },
    { source_consistent: false },
    { candidates: [{ user_id: 'invalid', cutoff_micros: '1' }] },
    { candidates: [{ user_id: userId, cutoff_micros: null }] },
    { candidates: [{ user_id: userId, cutoff_micros: 'not-a-time' }] },
    { candidates: [...row().candidates, ...row().candidates] },
  ])('fails closed for malformed stored source %j', async (patch) => {
    const s = setup([{ ...row(), ...patch }]);
    await expect(
      s.repository.find(fundId, 'CONTRIBUTION_DUE', sourceId, deadline()),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('checks the shared deadline immediately after pool acquisition before any query', async () => {
    const s = setup();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    s.database.withTransaction.mockImplementation(async (work) => {
      vi.mocked(Date.now).mockReturnValue(201);
      return work({ query: s.query });
    });
    await expect(
      s.repository.find(fundId, 'CONTRIBUTION_DUE', sourceId, 200),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(s.query).not.toHaveBeenCalled();
  });

  it('rejects a source read which finishes after the shared deadline', async () => {
    const s = setup();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    s.query.mockImplementation(async (text: string) => {
      if (text.startsWith('SELECT f.')) vi.mocked(Date.now).mockReturnValue(201);
      return { rows: text.startsWith('SELECT f.') ? [row()] : [] };
    });
    await expect(
      s.repository.find(fundId, 'CONTRIBUTION_DUE', sourceId, 200),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
