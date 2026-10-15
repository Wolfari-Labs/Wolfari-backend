import { responseRecord, timestampToIso, uuid } from './trip-http';

function integer(value: unknown, positive = false): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    /[^0-9]/u.test(value) ||
    (value.length > 1 && value[0] === '0') ||
    value.length > 19 ||
    BigInt(value) > 9223372036854775807n ||
    (positive && value === '0')
  )
    throw new Error('Invalid ledger integer');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid ledger identifier');
  return value;
}
const optionalId = (value: unknown) => (value === undefined ? null : identifier(value));

export function projectLedgerPage(value: unknown, fundId: string, limit: number) {
  const response = responseRecord(value),
    rows = response.items ?? [];
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('Invalid ledger page');
  let previous: bigint | undefined;
  const items = rows.map((value: unknown) => {
    const row = responseRecord(value);
    const sequence = integer(row.sequence, true);
    const direction = row.direction === 1 ? 'IN' : row.direction === 2 ? 'OUT' : undefined;
    if (
      row.fund_id !== fundId ||
      !direction ||
      !['CONTRIBUTION', 'EXPENSE', 'REFUND', 'REVERSAL'].includes(String(row.transaction_type)) ||
      (row.reason !== undefined && typeof row.reason !== 'string') ||
      (previous !== undefined && BigInt(sequence) >= previous)
    )
      throw new Error('Invalid ledger row');
    previous = BigInt(sequence);
    return {
      id: identifier(row.id),
      fund_id: identifier(row.fund_id),
      sequence,
      direction,
      transaction_type: row.transaction_type,
      amount: integer(row.amount, true),
      balance_after: integer(row.balance_after),
      contribution_id: optionalId(row.contribution_id),
      expense_id: optionalId(row.expense_id),
      refund_id: optionalId(row.refund_id),
      reversal_of_id: optionalId(row.reversal_of_id),
      actor_user_id: optionalId(row.actor_user_id),
      reason: row.reason ?? null,
      created_at: timestampToIso(row.created_at),
    };
  });
  const cursor = response.next_cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' ||
      !cursor.length ||
      cursor.length > 512 ||
      /[^A-Za-z0-9_-]/u.test(cursor) ||
      items.length !== limit)
  )
    throw new Error('Invalid ledger continuation');
  return { items, next_cursor: cursor ?? null };
}
