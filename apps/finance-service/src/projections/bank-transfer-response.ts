import type { FinanceV1 } from '@wolfari/contracts/grpc';

export type BankTransferRow = {
  id: string;
  provider: string;
  provider_transaction_id: string;
  transfer_type: string;
  amount: string;
  content: string;
  account_number: string;
  bank_gateway: string | null;
  processing_status: string;
  review_reason: string | null;
  contribution_id: string | null;
  transaction_at: Date | string | null;
  received_at: Date | string;
  processed_at: Date | string | null;
};

function timestamp(value: Date | string | null) {
  if (value === null) return undefined;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid bank transfer timestamp');
  const seconds = Math.floor(ms / 1000);
  return { seconds: String(seconds), nanos: (ms - seconds * 1000) * 1000000 };
}

/** Holder/Owner projection: the receiving account is masked and the raw payload never leaves Finance. */
export function bankTransferResponse(row: BankTransferRow): FinanceV1.BankTransferView {
  const digits = row.account_number.replace(/\s+/g, '');
  return {
    id: row.id,
    provider: row.provider,
    provider_transaction_id: row.provider_transaction_id,
    transfer_type: row.transfer_type,
    amount: row.amount,
    content: row.content.length > 500 ? `${row.content.slice(0, 500)}…` : row.content,
    account_number_masked: `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`,
    bank_gateway: row.bank_gateway ?? '',
    processing_status: row.processing_status,
    contribution_id: row.contribution_id ?? undefined,
    review_reason: row.review_reason ?? undefined,
    transaction_at: timestamp(row.transaction_at),
    received_at: timestamp(row.received_at),
    processed_at: timestamp(row.processed_at),
  };
}
