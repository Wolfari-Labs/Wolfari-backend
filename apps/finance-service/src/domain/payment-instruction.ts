import { buildVietQrPayload, findVietQrBank, VietQrPayloadError } from '@wolfari/common';
import { FinanceReadError, UUID } from '../finance.errors';
import { renderQrSvg } from './qr-svg';

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

export const INSTRUCTION_WARNING =
  'Quét mã bằng ứng dụng ngân hàng và giữ nguyên số tiền, nội dung chuyển khoản. ' +
  'Wolfari không tự thấy tiền về: sau khi chuyển, bấm Báo đã chuyển để người giữ quỹ đối chiếu và xác nhận.';

/**
 * An instruction is a point-in-time read, never proof of a transfer. The QR is a standard NAPAS
 * VietQR account-transfer code built locally from the destination snapshot of this contribution;
 * no provider is contacted and nothing about the member or the Holder leaves the platform.
 */
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
  // Destinations written before directory validation may carry unknown codes: fail closed.
  const bank = findVietQrBank(bankCode);
  if (!bank || !bank.transfer_supported || [...name].length > 150) return conflict();
  const reference = BigInt(`0x${row.id.replaceAll('-', '')}`)
    .toString(36)
    .toUpperCase()
    .padStart(25, '0');
  let payload: string;
  try {
    payload = buildVietQrPayload({
      bankBin: bank.bin,
      accountNumber: account,
      amount: row.amount,
      addInfo: reference,
    });
  } catch (error) {
    // Account or amount outside what NAPAS encodes: the member needs a corrected destination.
    if (error instanceof VietQrPayloadError) return conflict();
    throw error;
  }
  return {
    contribution_id: row.id,
    amount: row.amount,
    currency: 'VND',
    reference,
    recipient_name: name,
    bank_code: bank.code,
    bank_bin: bank.bin,
    bank_name: bank.short_name,
    account_number: account,
    qr_payload: payload,
    qr_svg: renderQrSvg(payload, 'VietQR'),
    qr_url: '',
    environment: 'LIVE',
    warning: INSTRUCTION_WARNING,
  };
}
