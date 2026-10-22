import type { FinanceV1 } from '@wolfari/contracts/grpc';

export type PaymentAttemptRow = {
  id: string;
  contribution_id: string;
  provider: string;
  environment: string;
  amount: string;
  currency: string;
  status: string;
  provider_payload: unknown;
  needs_reconciliation: boolean;
  expires_at: Date | string | null;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
export type PaymentExceptionRow = {
  id: string;
  payment_attempt_id: string | null;
  processing_status: string;
  review_reason: string | null;
  received_at: Date | string;
  reviewed_at: Date | string | null;
};
const timestamp = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid payment timestamp');
  const ms = date.getTime();
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
};
const optionalTimestamp = (value: Date | string | null) =>
  value === null ? undefined : timestamp(value);

export function paymentAttemptResponse(row: PaymentAttemptRow): FinanceV1.PaymentAttemptView {
  const payload =
    row.provider_payload &&
    typeof row.provider_payload === 'object' &&
    !Array.isArray(row.provider_payload)
      ? (row.provider_payload as Record<string, unknown>)
      : {};
  const paymentUrl = typeof payload.payment_url === 'string' ? payload.payment_url : undefined;
  return {
    id: row.id,
    contribution_id: row.contribution_id,
    provider: row.provider,
    environment: row.environment,
    amount: row.amount,
    currency: row.currency.trimEnd(),
    status: row.status,
    needs_reconciliation: row.needs_reconciliation,
    payment_url: paymentUrl,
    expires_at: optionalTimestamp(row.expires_at),
    error_code: row.error_code ?? undefined,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

export function paymentExceptionResponse(row: PaymentExceptionRow): FinanceV1.PaymentExceptionView {
  if (!row.review_reason) throw new Error('Payment exception is missing its reason');
  return {
    id: row.id,
    payment_attempt_id: row.payment_attempt_id ?? undefined,
    processing_status: row.processing_status,
    review_reason: row.review_reason,
    received_at: timestamp(row.received_at),
    reviewed_at: optionalTimestamp(row.reviewed_at),
  };
}
