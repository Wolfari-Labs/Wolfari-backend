import { FinanceReadError, readUuid } from '../finance.errors';
import { BANK_TRANSFER_RESOLUTIONS, type BankTransferInput } from '../repositories/bank-transfer.repository';

const invalid = (): never => {
  throw new FinanceReadError('VALIDATION_FAILED');
};
function text(value: unknown, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === '') return required ? invalid() : null;
  if (typeof value !== 'string' || value.includes('\u0000') || [...value].length > max)
    return invalid();
  if (required && !value.trim()) return invalid();
  return value;
}
/** SePay sends `YYYY-MM-DD HH:mm:ss` in Vietnam time; ISO-8601 is accepted too. Unparseable → null. */
export function parseTransactionDate(value: string | null): Date | null {
  if (!value) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  const candidate = local
    ? new Date(`${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]}+07:00`)
    : new Date(value);
  return Number.isFinite(candidate.getTime()) ? candidate : null;
}

export function parseBankTransferInput(input: {
  provider?: unknown;
  provider_transaction_id?: unknown;
  transfer_type?: unknown;
  amount?: unknown;
  content?: unknown;
  account_number?: unknown;
  bank_gateway?: unknown;
  reference_code?: unknown;
  sub_account?: unknown;
  transaction_date?: unknown;
  payload_json?: unknown;
}): BankTransferInput {
  if (input.provider !== 'SEPAY') return invalid();
  const providerTransactionId = text(input.provider_transaction_id, 150, true)!;
  if (!/^[0-9A-Za-z_-]+$/.test(providerTransactionId)) return invalid();
  if (input.transfer_type !== 'IN' && input.transfer_type !== 'OUT') return invalid();
  const amount = text(input.amount, 19, true)!;
  if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > 9223372036854775807n) return invalid();
  const payloadText = text(input.payload_json, 65536, true)!;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return invalid();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
  return {
    provider: 'SEPAY',
    providerTransactionId,
    transferType: input.transfer_type,
    amount: BigInt(amount),
    content: text(input.content, 2000, false) ?? '',
    accountNumber: text(input.account_number, 80, true)!,
    bankGateway: text(input.bank_gateway, 80, false),
    referenceCode: text(input.reference_code, 150, false),
    subAccount: text(input.sub_account, 80, false),
    transactionAt: parseTransactionDate(text(input.transaction_date, 40, false)),
    payload,
  };
}

/** Holder resolution of a NEEDS_REVIEW transfer: known outcome, a short note and the Fund version seen. */
export function parseBankTransferResolution(input: {
  operation_id?: unknown;
  actor_user_id?: unknown;
  fund_id?: unknown;
  bank_transfer_id?: unknown;
  resolution?: unknown;
  note?: unknown;
  expected_finance_version?: unknown;
}) {
  const uuid = (value: unknown) => {
    try {
      return readUuid(value);
    } catch {
      return invalid();
    }
  };
  const resolution = BANK_TRANSFER_RESOLUTIONS.find((item) => item === input.resolution);
  if (!resolution) return invalid();
  const note = text(input.note, 500, true)!.trim();
  const version = input.expected_finance_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 2147483647)
    return invalid();
  return {
    operationId: uuid(input.operation_id),
    actor: uuid(input.actor_user_id),
    fundId: uuid(input.fund_id),
    transferId: uuid(input.bank_transfer_id),
    resolution,
    note,
    expectedFinanceVersion: version,
  };
}
