import { findVietQrBank, VIETQR_ACCOUNT } from '@wolfari/common';
import {
  assertDestinationText,
  assertValidFundDestination,
  FundSetupValidationError,
  type FundDestination,
} from '../domain/fund-setup';
import type {
  CreatePaymentDestinationCommand,
  DestinationPatch,
  DestinationVersions,
  UpdatePaymentDestinationCommand,
} from '../domain/payment-destination-management';

export class PaymentDestinationInputError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid payment destination input: ${field}`);
    this.name = 'PaymentDestinationInputError';
  }
}

const FIELD_MAP = {
  destination_type: 'destinationType',
  is_default: 'isDefault',
  active: 'active',
  bank_code: 'bankCode',
  account_number: 'accountNumber',
  account_name: 'accountName',
  momo_phone: 'momoPhone',
} as const;
const CONFIG_FIELDS = Object.keys(FIELD_MAP);
const LENGTHS: Readonly<Record<string, number>> = {
  bank_code: 30,
  account_number: 80,
  account_name: 150,
  momo_phone: 30,
};
const VERSIONS = ['expected_version', 'expected_finance_version'];
function invalid(field: string): never {
  throw new PaymentDestinationInputError(field);
}
function object(input: unknown, field = 'body'): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    return invalid(field);
  return input as Record<string, unknown>;
}
function allowOnly(body: Record<string, unknown>, fields: readonly string[], field = 'body'): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) invalid(field);
}
function version(body: Record<string, unknown>, field: string): number {
  const value = Object.hasOwn(body, field) ? body[field] : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid(field);
  return value;
}
function parseFields(body: Record<string, unknown>, prefix = ''): DestinationPatch {
  const result: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(FIELD_MAP)) {
    if (!Object.hasOwn(body, key)) continue;
    let value = body[key];
    if (key === 'destination_type') {
      if (value !== 'VIETQR' && value !== 'MOMO_SANDBOX') invalid(`${prefix}${key}`);
    } else if (key === 'active' || key === 'is_default') {
      if (typeof value !== 'boolean') invalid(`${prefix}${key}`);
    } else {
      if (key === 'bank_code') {
        // Accept the VietQR code in any letter case or the 6-digit BIN; store the canonical code.
        const bank = findVietQrBank(typeof value === 'string' ? value.trim() : value);
        if (!bank?.transfer_supported) invalid(`${prefix}${key}`);
        value = bank!.code;
      } else if (key === 'account_number') {
        // Account numbers are often typed or pasted with grouping spaces.
        if (typeof value === 'string') value = value.replace(/\s+/g, '');
        if (typeof value !== 'string' || !VIETQR_ACCOUNT.test(value)) invalid(`${prefix}${key}`);
      }
      try {
        assertDestinationText(value, `${prefix}${key}`, LENGTHS[key]);
      } catch (error) {
        if (error instanceof FundSetupValidationError) return invalid(error.field);
        throw error;
      }
    }
    result[target] = value;
  }
  if (typeof result.momoPhone === 'string') {
    const phone = vietnameseMobile(result.momoPhone);
    if (!phone) return invalid(`${prefix}momo_phone`);
    result.momoPhone = phone;
  }
  return result as DestinationPatch;
}

/**
 * MoMo wallets are keyed by a Vietnamese mobile number. Accept common typed forms
 * (spaces, dots, dashes, +84/84 prefix) and store the 10-digit national form 0XXXXXXXXX.
 * Applies to new writes only; stored destinations are not re-validated.
 */
export function vietnameseMobile(value: string): string | null {
  const digits = value.trim().replace(/[\s.-]/g, '');
  const national = /^\+?84\d{9}$/.test(digits) ? `0${digits.replace(/^\+?84/, '')}` : digits;
  return /^0[35789]\d{8}$/.test(national) ? national : null;
}

/** Shared DestinationWrite parser; API070 preserves its nested error paths. */
export function parsePaymentDestinationConfiguration(
  input: unknown,
  nested = false,
): FundDestination {
  const group = nested ? 'destination' : 'body';
  const prefix = nested ? 'destination.' : '';
  const body = object(input, group);
  const kind = Object.hasOwn(body, 'destination_type') ? body.destination_type : undefined;
  if (kind !== 'VIETQR' && kind !== 'MOMO_SANDBOX') return invalid(`${prefix}destination_type`);
  const fields = [
    'destination_type',
    'is_default',
    'active',
    ...(kind === 'VIETQR' ? ['bank_code', 'account_number', 'account_name'] : ['momo_phone']),
  ];
  allowOnly(body, fields, group);
  for (const field of fields) if (!Object.hasOwn(body, field)) invalid(`${prefix}${field}`);
  const configuration = parseFields(body, prefix) as FundDestination;
  try {
    assertValidFundDestination(configuration);
  } catch (error) {
    if (error instanceof FundSetupValidationError)
      return invalid(nested ? error.field : error.field.replace(/^destination\./, ''));
    throw error;
  }
  return configuration;
}

/** API074 has flat DestinationWrite fields, unlike API070. */
export function parseCreatePaymentDestinationInput(
  input: unknown,
): CreatePaymentDestinationCommand {
  const body = object(input);
  allowOnly(body, [...CONFIG_FIELDS, 'expected_finance_version']);
  const configuration = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== 'expected_finance_version'),
  );
  return {
    destination: parsePaymentDestinationConfiguration(configuration),
    expectedFinanceVersion: version(body, 'expected_finance_version'),
  };
}

/** API075: the server supplies the actor and confirmation timestamp. */
export function parseConfirmPaymentDestinationInput(input: unknown): DestinationVersions {
  const body = object(input);
  allowOnly(body, VERSIONS);
  return {
    expectedVersion: version(body, 'expected_version'),
    expectedFinanceVersion: version(body, 'expected_finance_version'),
  };
}

/** API076 validates syntax; domain checks the patch against the actual record. */
export function parseUpdatePaymentDestinationInput(
  input: unknown,
): UpdatePaymentDestinationCommand {
  const body = object(input);
  allowOnly(body, [...CONFIG_FIELDS, ...VERSIONS]);
  const patch = parseFields(body);
  if (Object.keys(patch).length === 0) return invalid('patch');
  return {
    patch,
    expectedVersion: version(body, 'expected_version'),
    expectedFinanceVersion: version(body, 'expected_finance_version'),
  };
}
