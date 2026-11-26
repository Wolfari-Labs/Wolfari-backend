/**
 * The transfer content of a contribution (API086 VietQR addInfo, SePay matching): the contribution
 * UUID as 25 base-36 characters. Deterministic, so the Gateway can show it on every contribution
 * and a Holder can match a bank statement line by hand. One formula for Finance and the Gateway.
 */
export function contributionTransferReference(contributionId: string): string {
  return BigInt(`0x${contributionId.replaceAll('-', '')}`)
    .toString(36)
    .toUpperCase()
    .padStart(25, '0');
}

/**
 * System actors Finance writes into its audit history (API162): the MoMo sandbox IPN and its
 * reconciliation, the bank webhook per provider, and payOS's webhook and reconciliation.
 */
export const FINANCE_SYSTEM_ACTORS = Object.freeze([
  'MOMO_IPN',
  'MOMO_RECONCILIATION',
  'BANK_WEBHOOK:SEPAY',
  'PAYOS_WEBHOOK',
  'PAYOS_RECONCILIATION',
] as const);
