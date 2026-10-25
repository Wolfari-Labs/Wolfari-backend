import { FinanceReadError, UUID } from '../finance.errors';
import { VIETQR_BANKS } from './vietqr-banks';

export interface PaymentInstructionRow {
  id: string;
  fund_id: string;
  trip_id: string;
  member_user_id: string;
  holder_user_id: string;
  amount: string;
  currency: string;
  status: string;
  fund_status: string;
  request_status: string;
  destination_version: number;
  destination_snapshot: unknown;
  blocked_payment: boolean;
}
const unavailable = (): never => {
  throw new FinanceReadError('SERVICE_UNAVAILABLE');
};
const conflict = (): never => {
  throw new FinanceReadError('STATE_CONFLICT');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || /[\u0000-\u001f\u007f]/u.test(value))
    return unavailable();
  return value;
}

/** An instruction is a point-in-time read, never proof of a transfer. */
export function paymentInstruction(row: PaymentInstructionRow) {
  if (
    row.status !== 'PENDING' ||
    row.fund_status !== 'OPEN' ||
    row.request_status !== 'OPEN' ||
    row.blocked_payment
  )
    return conflict();
  const snapshot = record(row.destination_snapshot);
  if (
    snapshot.schema_version !== 1 ||
    snapshot.fund_id !== row.fund_id ||
    snapshot.destination_version !== row.destination_version ||
    !Number.isInteger(row.destination_version) ||
    row.destination_version < 1 ||
    !UUID.test(text(snapshot.destination_id)) ||
    !UUID.test(text(snapshot.holder_user_id)) ||
    !Number.isFinite(Date.parse(text(snapshot.confirmed_by_holder_at)))
  )
    return unavailable();
  if (snapshot.holder_user_id !== row.holder_user_id) return conflict();
  if (snapshot.destination_type === 'MOMO_SANDBOX') return conflict();
  if (snapshot.destination_type !== 'VIETQR' || row.currency !== 'VND' || !UUID.test(row.id))
    return unavailable();
  if (!/^[1-9]\d{0,18}$/.test(row.amount) || BigInt(row.amount) > 9223372036854775807n)
    return unavailable();
  const recipient = record(snapshot.recipient);
  const bankCode = text(recipient.bank_code);
  const account = text(recipient.account_number);
  const name = text(recipient.account_name);
  const bank = VIETQR_BANKS.find((b) => b.code === bankCode.toUpperCase() || b.bin === bankCode);
  // These are QuickLink limits, not limits on the existing Money/account schema.
  if (!bank || !/^[a-zA-Z0-9]{1,19}$/.test(account) || row.amount.length > 13 || name.length > 150)
    return conflict();
  const reference = BigInt(`0x${row.id.replaceAll('-', '')}`)
    .toString(36)
    .toUpperCase()
    .padStart(25, '0');
  const url = new URL(`https://img.vietqr.io/image/${bank.bin}-${account}-compact2.svg`);
  url.searchParams.set('amount', row.amount);
  url.searchParams.set('addInfo', reference);
  url.searchParams.set('accountName', name);
  return {
    contribution_id: row.id,
    amount: row.amount,
    currency: 'VND',
    reference,
    recipient_name: name,
    bank_code: bankCode,
    bank_bin: bank.bin,
    account_number: account,
    qr_url: url.toString(),
    environment: 'TEST',
    warning:
      'TEST ONLY. QR does not prove payment. Loading the QR sends recipient and transfer details to Casso. A real bank account can receive real money even when this screen says TEST.',
  };
}
