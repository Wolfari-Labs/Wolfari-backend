import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceOutboxRepository, type ClaimedFinanceEvent } from './finance-outbox.repository';

const id = '10000000-0000-4000-8000-000000000001';
function claim(attempt = 1): ClaimedFinanceEvent {
  return {
    event_id: id,
    event_type: 'ContributionUpdated',
    schema_version: 1,
    occurred_at: new Date('2026-10-25T12:00:00.000Z'),
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: id,
    aggregate_version: 2,
    correlation_id: id,
    causation_id: null,
    operation_id: null,
    trip_id: id,
    actor_user_id: id,
    system_actor: null,
    payload: {
      fund_id: id,
      trip_id: id,
      contribution_id: id,
      status: 'PENDING',
      finance_version: 2,
    },
    claim_owner: '20000000-0000-4000-8000-000000000001',
    claim_until: new Date('2099-01-01T00:00:00.000Z'),
    attempt_count: attempt,
  };
}
function setup() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const clientQuery = vi
    .fn()
    .mockImplementation((config) =>
      ['BEGIN', 'COMMIT'].includes(config.text)
        ? Promise.resolve({ rows: [], rowCount: null })
        : query(config.text, config.values),
    );
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query: clientQuery, release }) };
  return {
    query,
    clientQuery,
    release,
    pool,
    repository: new FinanceOutboxRepository({ pool } as never),
  };
}
afterEach(() => vi.useRealTimers());

describe('Finance outbox persistence', () => {
  it('uses a distinct lease token for every claim and leaves an empty queue empty', async () => {
    const s = setup();
    expect(await s.repository.claimNext()).toBeUndefined();
    await s.repository.claimNext();
    const owners = s.query.mock.calls.map((call) => call[1][0]);
    expect(owners[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(owners[1]).not.toBe(owners[0]);
    expect(s.pool.connect).toHaveBeenCalledTimes(2);
    expect(s.release.mock.calls).toEqual([[false], [false]]);
  });

  it.each([
    ['complete', true],
    ['complete', false],
    ['fail', true],
    ['fail', false],
  ] as const)('%s reports whether the lease-fenced update matched: %s', async (method, matched) => {
    const s = setup(),
      value = claim();
    s.query.mockResolvedValue({ rows: [], rowCount: matched ? 1 : 0 });
    const result =
      method === 'complete'
        ? await s.repository.complete(value)
        : await s.repository.fail(value, 'PUBLISH_FAILED');
    expect(result).toBe(matched);
    expect(s.query.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([id, value.claim_owner, 1]);
  });

  it.each([
    [1, 10000],
    [2, 30000],
    [3, 120000],
    [4, 300000],
    [5, 900000],
    [6, 900000],
    [2147483647, 900000],
  ])('keeps transient attempt %s pending with capped delay %s', async (attempt, delay) => {
    const s = setup();
    await s.repository.fail(claim(attempt), 'PUBLISH_FAILED');
    expect(s.query.mock.calls[0]?.[1]?.slice(3)).toEqual(['PENDING', delay, 'PUBLISH_FAILED']);
  });

  it.each([
    ['PUBLISH_FAILED', true],
    ['INVALID_EVENT', false],
  ] as const)(
    'rejects an inconsistent permanent failure classification %s/%s',
    async (reason, permanent) => {
      const s = setup();
      await expect(s.repository.fail(claim(), reason, permanent)).rejects.toThrow(
        'INVALID_FINANCE_OUTBOX_FAILURE',
      );
      expect(s.query).not.toHaveBeenCalled();
    },
  );

  it('retains invalid contract rows as FAILED without storing raw validation errors', async () => {
    const s = setup();
    await s.repository.fail(claim(), 'INVALID_EVENT', true);
    expect(s.query.mock.calls[0]?.[1]?.slice(3)).toEqual(['FAILED', 10000, 'INVALID_EVENT']);
  });

  it('replays only a locked valid failed event with an explicit reason and preserves its envelope', async () => {
    const s = setup(),
      value = claim(),
      before = structuredClone(value);
    s.query.mockResolvedValueOnce({ rows: [value], rowCount: 1 });
    expect(await s.repository.replayFailed(id, 'INC-123')).toBe(true);
    expect(s.pool.connect).toHaveBeenCalledTimes(1);
    expect(
      s.clientQuery.mock.calls
        .map((call) => call[0].text)
        .filter((text) => text === 'BEGIN' || text === 'COMMIT'),
    ).toEqual(['BEGIN', 'COMMIT']);
    expect(s.clientQuery.mock.calls.every((call) => call[0].query_timeout === 5000)).toBe(true);
    expect(s.release).toHaveBeenCalledWith(false);
    expect(s.query.mock.calls[1]?.[1]).toEqual([id, 'OPERATOR_REPLAY:INC-123']);
    expect(value).toEqual(before);
  });

  it('does not replay an unavailable/active/nonFAILED row or an invalid envelope', async () => {
    const s = setup();
    expect(await s.repository.replayFailed(id, 'INC-123')).toBe(false);
    s.query.mockResolvedValue({ rows: [{ ...claim(), producer: 'Identity' }], rowCount: 1 });
    await expect(s.repository.replayFailed(id, 'INC-123')).rejects.toThrow();
    expect(s.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invalid', 'INC-123'],
    [id, ''],
    [id, 'private reason with spaces'],
    [id, 'a'.repeat(81)],
  ])('rejects malformed replay input before database access', async (eventId, reason) => {
    const s = setup();
    await expect(s.repository.replayFailed(eventId!, reason!)).rejects.toThrow(
      'INVALID_FINANCE_OUTBOX_REPLAY',
    );
    expect(s.query).not.toHaveBeenCalled();
  });

  it('sets a client-side response timeout and destroys a stalled borrowed connection', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.clientQuery.mockImplementation(
      (config) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Query read timeout')), config.query_timeout);
        }),
    );
    const work = s.repository.claimNext();
    const rejected = expect(work).rejects.toThrow('Query read timeout');
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(s.clientQuery.mock.calls[0]?.[0]).toMatchObject({
      query_timeout: 5000,
      values: [expect.any(String)],
    });
    expect(s.release).toHaveBeenCalledWith(true);
    expect(s.clientQuery).toHaveBeenCalledTimes(1);
  });

  it('destroys a failed replay transaction without another possibly stalled query', async () => {
    const s = setup();
    s.query.mockRejectedValue(new Error('connection unavailable'));
    await expect(s.repository.replayFailed(id, 'INC-123')).rejects.toThrow(
      'connection unavailable',
    );
    expect(s.clientQuery).toHaveBeenCalledTimes(2);
    expect(s.clientQuery.mock.calls[0]?.[0]).toMatchObject({ text: 'BEGIN', query_timeout: 5000 });
    expect(s.release).toHaveBeenCalledWith(true);
  });

  it('returns aggregate diagnostics without event identifiers or payload', async () => {
    const s = setup();
    s.query.mockResolvedValue({ rows: [{ pending: '12', failed: '3' }] });
    expect(await s.repository.diagnostics()).toEqual({ pending: 12, failed: 3 });
  });
});
