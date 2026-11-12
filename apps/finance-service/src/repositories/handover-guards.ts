import type { DatabaseProvider } from '@wolfari/database';
import { FinanceReadError } from '../finance.errors';

/** Caller holds the Fund lock used by all handover transitions. */
export async function assertNoHandover(
  client: Pick<DatabaseProvider, 'query'>,
  fundId: string,
  acceptedOnly = false,
) {
  const result = await client.query(
    `SELECT id FROM fund_holder_handovers WHERE fund_id=$1
     AND status=ANY($2::varchar[]) LIMIT 1`,
    [fundId, acceptedOnly ? ['ACCEPTED'] : ['NOMINATED', 'ACCEPTED']],
  );
  if (result.rows.length) throw new FinanceReadError('STATE_CONFLICT');
}
