import type { DatabaseProvider } from '@wolfari/database';
import type { PoolClient } from 'pg';

/** Retry only a definite PostgreSQL deadlock rollback, never an uncertain commit or external I/O. */
export async function withPriceWatchTransaction<T>(
  database: Pick<DatabaseProvider, 'withTransaction'>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await database.withTransaction(work);
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !('code' in error) || error.code !== '40P01')
        throw error;
      // withTransaction has rolled back and released its connection before rejecting.
    }
  }
}
