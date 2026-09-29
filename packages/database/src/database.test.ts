import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DatabaseProvider, databaseConfig } from './index';

const url = 'postgresql://identity_app:test@127.0.0.1:5432/identity_db';
describe('database provider configuration', () => {
  it('validates destination, roles and bounded numeric settings without exposing secrets', () => {
    expect(databaseConfig({ DATABASE_URL: url }, 'identity')).toMatchObject({ max: 5, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000, statement_timeout: 5000 });
    for (const bad of ['invalid', url.replace('identity_db', 'finance_db'), url.replace('identity_app', 'postgres'), `${url}?options=secret`]) {
      expect(() => databaseConfig({ DATABASE_URL: bad }, 'identity')).toThrow();
    }
    expect(() => databaseConfig({ DATABASE_URL: url, DATABASE_POOL_MAX: '0' }, 'identity')).toThrow('DATABASE_POOL_MAX');
  });
  it('rolls back and releases a transaction exactly once, including rollback failure', async () => {
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client), on: vi.fn(), end: vi.fn() };
    const provider = new DatabaseProvider(pool as unknown as Pool, databaseConfig({ DATABASE_URL: url }, 'identity'), 'identity');
    try {
      await expect(provider.withTransaction(async c => { expect(c).toBe(client); throw new Error('work failed'); })).rejects.toThrow('work failed');
      expect(client.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
      expect(client.release).toHaveBeenCalledWith(false);
      client.query.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('connection lost'));
      client.release.mockClear();
      await expect(provider.withTransaction(async () => { throw new Error('original'); })).rejects.toThrow('original');
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { await provider.onApplicationShutdown(); }
  });
});
