import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  historyCursor,
  historyInstant,
  historyPage,
  historyResponse,
  type HistoryRow,
} from './history.domain';
import { FinanceHistoryService } from './history.service';
import { FinanceHistoryRepository } from './history.repository';

const fund = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const row: HistoryRow = {
  id: fund,
  fund_id: fund,
  actor_user_id: actor,
  system_actor: null,
  action: 'UPDATE_FUND_BUDGET',
  entity_type: 'Fund',
  entity_id: fund,
  from_version: 1,
  to_version: 2,
  reason: null,
  reason_oversized: false,
  occurred_at: '2026-10-29T12:34:56.123456Z',
  correlation_id: actor,
};
const input = { fund_id: fund, actor_user_id: actor };

describe('Finance history projection and navigation', () => {
  it('retains microseconds, optional actor and existing version transition; excludes arbitrary details', () => {
    const result = historyResponse(
      { ...row, details: { bank: 'PRIVATE' }, token: 'PRIVATE' } as HistoryRow,
      fund,
    );
    expect(result.occurred_at?.nanos).toBe(123456000);
    expect(result).toMatchObject({ from_version: 1, to_version: 2, reason: undefined });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(
      historyResponse({ ...row, actor_user_id: null, system_actor: 'MOMO_IPN' }, fund),
    ).toMatchObject({ actor_user_id: undefined, system_actor: 'MOMO_IPN' });
  });
  it('binds cursors to actor and Fund without losing PostgreSQL precision', () => {
    const page = historyPage(input);
    const cursor = historyCursor(page, { at: row.occurred_at, id: row.id });
    expect(historyPage({ ...input, cursor, limit: 1 }).before).toEqual({
      at: row.occurred_at,
      id: row.id,
    });
    for (const change of [{ actor_user_id: fund }, { fund_id: actor }, { cursor: cursor + '=' }])
      expect(() => historyPage({ ...input, cursor, ...change })).toThrow('VALIDATION_FAILED');
  });
  it.each([0, -1, 101, 1.5, NaN, Infinity])('rejects limit %s', (limit) => {
    expect(() => historyPage({ ...input, limit })).toThrow('VALIDATION_FAILED');
  });
  it.each(['', '!!!', 'a'.repeat(1025), Buffer.from('[1,2]').toString('base64url')])(
    'rejects malformed cursor',
    (cursor) => {
      expect(() => historyPage({ ...input, cursor })).toThrow('VALIDATION_FAILED');
    },
  );
  it.each([
    '2026-02-30T12:34:56.123456Z',
    '2026-10-29T12:34:56.123Z',
    '0000-01-01T00:00:00.000000Z',
  ])('rejects noncanonical instant %s', (at) => expect(historyInstant(at)).toBe(false));
  it.each([
    { fund_id: actor },
    { action: 'SUPPORT_READ' },
    { entity_type: 'secret/value' },
    { system_actor: 'UNKNOWN_PROVIDER' },
    { reason: 'x'.repeat(2001) },
    { reason_oversized: true },
    { from_version: 0 },
    { to_version: 2147483648 },
    { occurred_at: 'bad' },
    { correlation_id: 'bad' },
  ])('rejects corrupt stored records without treating them as user validation', (change) => {
    expect(() => historyResponse({ ...row, ...change }, fund)).toThrow();
  });
});

describe('Finance history current access', () => {
  function setup() {
    const auth = { authorizeFundRead: vi.fn().mockResolvedValue(1) };
    const repository = { list: vi.fn().mockResolvedValue([row, { ...row, id: actor }]) };
    return { auth, repository, service: new FinanceHistoryService(auth, repository) };
  }
  it('checks authority before and after SQL and emits a cursor only with another row', async () => {
    const s = setup();
    const response = await s.service.list({ ...input, limit: 1 }, actor, Date.now() + 5000);
    expect(response.items).toHaveLength(1);
    expect(response.next_cursor).toBeTruthy();
    expect(s.auth.authorizeFundRead).toHaveBeenCalledTimes(2);
    expect(s.auth.authorizeFundRead.mock.invocationCallOrder[0]).toBeLessThan(
      s.repository.list.mock.invocationCallOrder[0]!,
    );
    expect(s.auth.authorizeFundRead.mock.invocationCallOrder[1]).toBeGreaterThan(
      s.repository.list.mock.invocationCallOrder[0]!,
    );
    s.repository.list.mockResolvedValueOnce([]);
    expect(await s.service.list(input, actor, Date.now() + 5000)).toEqual({
      items: [],
      next_cursor: undefined,
    });
  });
  it('does not read SQL for invalid input or denied membership', async () => {
    const s = setup();
    await expect(s.service.list({ ...input, limit: 0 }, actor, Date.now() + 5000)).rejects.toThrow(
      'VALIDATION_FAILED',
    );
    expect(s.auth.authorizeFundRead).not.toHaveBeenCalled();
    s.auth.authorizeFundRead.mockRejectedValueOnce(new Error('RESOURCE_NOT_FOUND'));
    await expect(s.service.list(input, actor, Date.now() + 5000)).rejects.toThrow(
      'RESOURCE_NOT_FOUND',
    );
    expect(s.repository.list).not.toHaveBeenCalled();
  });
  it('discards an otherwise valid page after membership revocation or deadline expiry', async () => {
    const s = setup();
    s.auth.authorizeFundRead
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('RESOURCE_NOT_FOUND'));
    await expect(s.service.list(input, actor, Date.now() + 5000)).rejects.toThrow(
      'RESOURCE_NOT_FOUND',
    );
    await expect(s.service.list(input, actor, Date.now() - 1)).rejects.toThrow(
      'SERVICE_UNAVAILABLE',
    );
  });
});

describe('Finance history SQL boundary', () => {
  function setup() {
    const query = vi
      .fn()
      .mockImplementation(async (arg) =>
        typeof arg === 'object' ? { rows: [row] } : { rows: [] },
      );
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    return { client, pool, repository: new FinanceHistoryRepository({ pool } as never) };
  }
  it('uses a read-only transaction, scoped parameters and limited scalar reason extraction', async () => {
    const s = setup();
    expect(await s.repository.list(historyPage(input), Date.now() + 5000)).toEqual([row]);
    expect(s.client.query).toHaveBeenCalledWith('BEGIN READ ONLY');
    const config = s.client.query.mock.calls.find(([arg]) => typeof arg === 'object')![0];
    expect(config.text).toContain('ORDER BY occurred_at DESC,id DESC');
    expect(config.text).not.toMatch(/SELECT\s+\*|details\s*,|provider_payload/i);
    expect(config.values.slice(0, 4)).toEqual([fund, null, null, 21]);
    expect(config.values[4]).not.toContain('SUPPORT_READ');
    expect(s.client.query).toHaveBeenCalledWith('COMMIT');
    expect(s.client.release).toHaveBeenCalledWith(false);
  });
  it('rolls back query failure and destroys a connection if rollback also fails', async () => {
    const s = setup();
    s.client.query.mockImplementation(async (arg) => {
      if (typeof arg === 'object' || arg === 'ROLLBACK') throw new Error('SQL failure');
      return { rows: [] };
    });
    await expect(s.repository.list(historyPage(input), Date.now() + 5000)).rejects.toThrow(
      'SQL failure',
    );
    expect(s.client.release).toHaveBeenCalledWith(true);
  });
  it('does not acquire a connection after expiry', async () => {
    const s = setup();
    await expect(s.repository.list(historyPage(input), Date.now() - 1)).rejects.toThrow(
      'SERVICE_UNAVAILABLE',
    );
    expect(s.pool.connect).not.toHaveBeenCalled();
  });
});
