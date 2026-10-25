import {
  type EnableFundCommand,
  type FundDestination,
  type UpdateFundBudgetCommand,
} from '../domain/fund-setup';
import { parseVndAmount } from '../domain/money';
import {
  parsePaymentDestinationConfiguration,
  PaymentDestinationInputError,
} from './payment-destination.input';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FundSetupInputError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid fund setup input: ${field}`);
    this.name = 'FundSetupInputError';
  }
}

function invalid(field: string): never {
  throw new FundSetupInputError(field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid(field);
  return value as Record<string, unknown>;
}

function allowOnly(body: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid(field);
}

function required(body: Record<string, unknown>, key: string, field = key): unknown {
  if (!Object.hasOwn(body, key)) return invalid(field);
  return body[key];
}

function money(value: unknown): bigint {
  try {
    return parseVndAmount(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid('budget_amount');
    throw error;
  }
}

function destination(value: unknown): FundDestination {
  try {
    return parsePaymentDestinationConfiguration(value, true);
  } catch (error) {
    if (error instanceof PaymentDestinationInputError) return invalid(error.field);
    throw error;
  }
}

/**
 * API070 JSON body only. Omitted budget becomes internal null; explicit null is not
 * Money in this request. No actor, initial balance, confirmation, ID or snapshot is added.
 * The adapter must validate path/identity/idempotency separately and obtain the Trip guard.
 */
export function parseEnableFundInput(input: unknown): EnableFundCommand {
  const body = object(input, 'body');
  allowOnly(body, ['holder_user_id', 'currency', 'budget_amount', 'destination'], 'body');
  const holderUserId = required(body, 'holder_user_id');
  if (typeof holderUserId !== 'string' || holderUserId.length !== 36 || !UUID.test(holderUserId)) {
    return invalid('holder_user_id');
  }
  if (required(body, 'currency') !== 'VND') return invalid('currency');
  return {
    holderUserId: holderUserId.toLowerCase(),
    currency: 'VND',
    budgetAmount: Object.hasOwn(body, 'budget_amount') ? money(body.budget_amount) : null,
    destination: destination(required(body, 'destination')),
  };
}

/** API072 JSON body: budget is required, and null explicitly clears the planned budget. */
export function parseUpdateFundBudgetInput(input: unknown): UpdateFundBudgetCommand {
  const body = object(input, 'body');
  allowOnly(body, ['budget_amount', 'expected_finance_version'], 'body');
  const value = required(body, 'budget_amount');
  const version = required(body, 'expected_finance_version');
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2147483647
  ) {
    return invalid('expected_finance_version');
  }
  return {
    budgetAmount: value === null ? null : money(value),
    expectedFinanceVersion: version,
  };
}
