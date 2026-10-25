import { FinanceV1 } from '@wolfari/contracts/grpc';
import type { FundSummary } from '../repositories/fund.repository';
import type { DestinationListRow } from '../repositories/payment-destination-query.repository';

function timestamp(value: Date | null): { seconds: string; nanos: number } | undefined {
  if (value === null) return undefined;
  const ms = value.getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid stored timestamp');
  return { seconds: String(Math.floor(ms / 1000)), nanos: (((ms % 1000) + 1000) % 1000) * 1000000 };
}
export function fundResponse(fund: FundSummary): FinanceV1.FundView {
  return {
    id: fund.id,
    trip_id: fund.tripId,
    holder_user_id: fund.holderUserId,
    currency: fund.currency,
    budget_amount: fund.budgetAmount?.toString(),
    current_balance: fund.currentBalance.toString(),
    reserved_refund: fund.reservedRefund.toString(),
    available_balance: fund.availableBalance.toString(),
    status: {
      OPEN: FinanceV1.FundStatus.FUND_STATUS_OPEN,
      CLOSING: FinanceV1.FundStatus.FUND_STATUS_CLOSING,
      CLOSED: FinanceV1.FundStatus.FUND_STATUS_CLOSED,
    }[fund.status],
    finance_version: fund.financeVersion,
    closed_at: timestamp(fund.closedAt),
  };
}
export function destinationResponse(
  row: DestinationListRow,
  includePrivate: boolean,
): FinanceV1.PaymentDestinationView {
  if (row.destination_type !== 'VIETQR' && row.destination_type !== 'MOMO_SANDBOX')
    throw new Error('Invalid stored destination type');
  const privateText = (value: string | null | undefined): string => {
    if (typeof value !== 'string' || !value.trim())
      throw new Error('Invalid stored destination configuration');
    return value;
  };
  return {
    id: row.id,
    fund_id: row.fund_id,
    destination_type:
      row.destination_type === 'VIETQR'
        ? FinanceV1.PaymentDestinationType.PAYMENT_DESTINATION_TYPE_VIETQR
        : FinanceV1.PaymentDestinationType.PAYMENT_DESTINATION_TYPE_MOMO_SANDBOX,
    is_default: row.is_default,
    active: row.active,
    version: row.version,
    confirmed_by_holder_at: timestamp(row.confirmed_by_holder_at),
    ...(includePrivate
      ? row.destination_type === 'VIETQR'
        ? {
            bank_code: privateText(row.bank_code),
            account_number: privateText(row.account_number),
            account_name: privateText(row.account_name),
          }
        : { momo_phone: privateText(row.momo_phone) }
      : {}),
  };
}
