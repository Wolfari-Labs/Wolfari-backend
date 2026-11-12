import { FinanceReadError, UUID } from '../finance.errors';

/** Validate immutable routing identity before treating a receipt as money held by the current Holder. */
export function destinationHolder(value: unknown, fundId: string): string {
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
  const snapshot = record(value),
    recipient = record(snapshot.recipient);
  const text = (item: unknown): item is string =>
    typeof item === 'string' && item.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(item);
  if (
    snapshot.schema_version !== 1 ||
    snapshot.fund_id !== fundId ||
    !text(snapshot.holder_user_id) ||
    !UUID.test(snapshot.holder_user_id) ||
    !text(snapshot.destination_id) ||
    !UUID.test(snapshot.destination_id) ||
    !Number.isInteger(snapshot.destination_version) ||
    Number(snapshot.destination_version) < 1 ||
    !text(snapshot.confirmed_by_holder_at) ||
    !Number.isFinite(Date.parse(snapshot.confirmed_by_holder_at)) ||
    (snapshot.destination_type === 'VIETQR'
      ? !['bank_code', 'account_number', 'account_name'].every((key) => text(recipient[key]))
      : snapshot.destination_type !== 'MOMO_SANDBOX' || !text(recipient.momo_phone))
  )
    throw new FinanceReadError('STATE_CONFLICT');
  return snapshot.holder_user_id.toLowerCase();
}

export function previousHolderReceiptAudit(
  previousHolder: string,
  currentHolder: string,
  confirmed?: true,
) {
  if (previousHolder === currentHolder) return {};
  if (confirmed !== true) throw new FinanceReadError('STATE_CONFLICT');
  return {
    previous_holder_transfer_confirmed: true,
    previous_holder_user_id: previousHolder,
    current_holder_user_id: currentHolder,
  };
}
