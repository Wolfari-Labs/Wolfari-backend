import { describe, expect, it, vi } from 'vitest';
import { withPriceWatchTransaction } from './price-watch-transaction';

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error('synthetic database failure'), { code });
}

describe('Price Watch database-only transaction retry', () => {
  it('returns a successful transaction without retrying', async () => {
    const value = { committed: true };
    const work = vi.fn().mockResolvedValue(value);
    const database = { withTransaction: vi.fn().mockImplementation((work) => work({})) };
    expect(await withPriceWatchTransaction(database as never, work)).toBe(value);
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('starts fresh database work only after the deadlocked transaction has rolled back', async () => {
    const events: string[] = [];
    const first = {};
    const second = {};
    const clients = [first, second];
    const work = vi.fn().mockImplementation(async (client) => {
      events.push('work');
      if (client === first) throw sqlError('40P01');
      expect(client).toBe(second);
      return 'committed';
    });
    const database = {
      withTransaction: vi.fn().mockImplementation(async (callback) => {
        events.push('begin');
        try {
          const result = await callback(clients.shift());
          events.push('commit');
          return result;
        } catch (error) {
          events.push('rollback');
          throw error;
        }
      }),
    };
    expect(await withPriceWatchTransaction(database as never, work)).toBe('committed');
    expect(events).toEqual(['begin', 'work', 'rollback', 'begin', 'work', 'commit']);
  });

  it('propagates the second deadlock without an unbounded retry', async () => {
    const failure = sqlError('40P01');
    const database = { withTransaction: vi.fn().mockRejectedValue(failure) };
    await expect(withPriceWatchTransaction(database as never, vi.fn())).rejects.toBe(failure);
    expect(database.withTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(['23505', '40001', '57014', '08006', 'VERSION_CONFLICT'])(
    'does not retry %s or reinterpret it as a provider failure',
    async (code) => {
      const failure = sqlError(code);
      const database = { withTransaction: vi.fn().mockRejectedValue(failure) };
      await expect(withPriceWatchTransaction(database as never, vi.fn())).rejects.toBe(failure);
      expect(database.withTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry an ambiguous error merely because its cause mentions a deadlock', async () => {
    const failure = new Error('connection lost during commit', { cause: sqlError('40P01') });
    const database = { withTransaction: vi.fn().mockRejectedValue(failure) };
    await expect(withPriceWatchTransaction(database as never, vi.fn())).rejects.toBe(failure);
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
  });
});
