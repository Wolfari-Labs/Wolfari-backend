import { assertVndAmount } from './money';

/** Input configuration only: not a stored destination, confirmation or payment snapshot. */
export type FundDestination = Readonly<
  { isDefault: boolean; active: boolean } & (
    | { destinationType: 'VIETQR'; bankCode: string; accountNumber: string; accountName: string }
    | { destinationType: 'MOMO_SANDBOX'; momoPhone: string }
  )
>;

export type EnableFundCommand = Readonly<{
  holderUserId: string;
  currency: 'VND';
  budgetAmount: bigint | null;
  destination: FundDestination;
}>;

export type UpdateFundBudgetCommand = Readonly<{
  budgetAmount: bigint | null;
  expectedFinanceVersion: number;
}>;

/** Trusted current Trip context; UUIDs must already be validated and normalized. */
export type FundSetupContext = Readonly<{
  actorUserId: string;
  ownerUserId: string;
  activeMemberUserIds: ReadonlySet<string>;
  tripArchived: boolean;
}>;

export type EnableFundContext = FundSetupContext & Readonly<{ fundExists: boolean }>;
export type UpdateFundBudgetContext = FundSetupContext &
  Readonly<{ fundStatus: 'OPEN' | 'CLOSING' | 'CLOSED'; financeVersion: number }>;

export class FundSetupValidationError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid fund setup field: ${field}`);
    this.name = 'FundSetupValidationError';
  }
}

export class FundSetupPermissionDeniedError extends Error {
  constructor() {
    super('Only the active Trip Owner can configure the Fund');
    this.name = 'FundSetupPermissionDeniedError';
  }
}

export class FundSetupConflictError extends Error {
  constructor(
    public readonly code:
      | 'TRIP_ARCHIVED'
      | 'FUND_ALREADY_EXISTS'
      | 'HOLDER_NOT_ACTIVE'
      | 'INACTIVE_DEFAULT'
      | 'FUND_NOT_OPEN'
      | 'FINANCE_VERSION_CONFLICT',
  ) {
    super(code);
    this.name = 'FundSetupConflictError';
  }
}

export function assertDestinationText(
  value: unknown,
  field: string,
  max: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\u0000') ||
    [...value].length > max
  ) {
    throw new FundSetupValidationError(field);
  }
}

/** Validate DestinationWrite values against V001, without verifying a bank account. */
export function assertValidFundDestination(destination: FundDestination): void {
  if (destination === null || typeof destination !== 'object') {
    throw new FundSetupValidationError('destination');
  }
  if (typeof destination.isDefault !== 'boolean') {
    throw new FundSetupValidationError('destination.is_default');
  }
  if (typeof destination.active !== 'boolean') {
    throw new FundSetupValidationError('destination.active');
  }
  switch (destination.destinationType) {
    case 'VIETQR':
      assertDestinationText(destination.bankCode, 'destination.bank_code', 30);
      assertDestinationText(destination.accountNumber, 'destination.account_number', 80);
      assertDestinationText(destination.accountName, 'destination.account_name', 150);
      return;
    case 'MOMO_SANDBOX':
      assertDestinationText(destination.momoPhone, 'destination.momo_phone', 30);
      return;
    default:
      throw new FundSetupValidationError('destination.destination_type');
  }
}

function assertOwnerCanConfigure(context: FundSetupContext): void {
  if (
    context.actorUserId !== context.ownerUserId ||
    !context.activeMemberUserIds.has(context.actorUserId)
  ) {
    throw new FundSetupPermissionDeniedError();
  }
  if (context.tripArchived) throw new FundSetupConflictError('TRIP_ARCHIVED');
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || version > 2147483647) {
    throw new RangeError('Version must be a positive PostgreSQL integer');
  }
}

/**
 * API070 / FR-FN01: validate a NEW enable intent only. Resolve replay separately.
 * The caller must obtain the Trip guard, resolve an existing non-deleted Trip and
 * enforce funds.trip_id uniqueness in the write transaction. No Fund/ID is created
 * here, and destination ownership or Holder consent is not established by this check.
 */
export function assertCanEnableFund(command: EnableFundCommand, context: EnableFundContext): void {
  assertOwnerCanConfigure(context);
  if (context.fundExists) throw new FundSetupConflictError('FUND_ALREADY_EXISTS');
  if (!context.activeMemberUserIds.has(command.holderUserId)) {
    throw new FundSetupConflictError('HOLDER_NOT_ACTIVE');
  }
  if (command.currency !== 'VND') throw new FundSetupValidationError('currency');
  if (command.budgetAmount !== null) assertVndAmount(command.budgetAmount);
  assertValidFundDestination(command.destination);
  if (!command.destination.active && command.destination.isDefault) {
    throw new FundSetupConflictError('INACTIVE_DEFAULT');
  }
}

/**
 * API072: validate against trusted Trip context and the Fund read under its lock.
 * The writer must persist budget/version/receipt/audit and applicable outbox together.
 * A budget is informational: this function changes no balance, reservation or ledger.
 */
export function assertCanUpdateFundBudget(
  command: UpdateFundBudgetCommand,
  context: UpdateFundBudgetContext,
): void {
  assertOwnerCanConfigure(context);
  if (context.fundStatus !== 'OPEN') throw new FundSetupConflictError('FUND_NOT_OPEN');
  assertVersion(context.financeVersion);
  assertVersion(command.expectedFinanceVersion);
  if (context.financeVersion !== command.expectedFinanceVersion) {
    throw new FundSetupConflictError('FINANCE_VERSION_CONFLICT');
  }
  if (command.budgetAmount !== null) assertVndAmount(command.budgetAmount);
}
