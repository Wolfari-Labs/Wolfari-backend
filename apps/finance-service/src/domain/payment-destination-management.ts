import {
  assertValidFundDestination,
  type FundDestination,
  type FundSetupContext,
} from './fund-setup';

/** Internal current-state projections, not a persistence or payment snapshot contract. */
export type PaymentDestinationState = Readonly<{
  id: string;
  fundId: string;
  version: number;
  confirmedByHolderAt: Date | null;
  configuration: FundDestination;
}>;

export type PaymentDestinationContext = FundSetupContext &
  Readonly<{
    fundId: string;
    holderUserId: string;
    fundStatus: 'OPEN' | 'CLOSING' | 'CLOSED';
    financeVersion: number;
  }>;

export type DestinationPatch = Readonly<{
  destinationType?: FundDestination['destinationType'];
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  momoPhone?: string;
  active?: boolean;
  isDefault?: boolean;
}>;

export type DestinationVersions = Readonly<{
  expectedVersion: number;
  expectedFinanceVersion: number;
}>;
export type CreatePaymentDestinationCommand = Readonly<{
  destination: FundDestination;
  expectedFinanceVersion: number;
}>;
export type UpdatePaymentDestinationCommand = DestinationVersions &
  Readonly<{ patch: DestinationPatch }>;

/** A plan only. Caller must reload under the Fund lock and persist atomically. */
export type DestinationChangePlan = Readonly<{
  configuration: FundDestination;
  changed: boolean;
  confirmation: 'KEEP' | 'CLEAR' | 'SET';
  demoteDefault: Readonly<{ id: string; expectedVersion: number }> | null;
}>;

export class PaymentDestinationPermissionError extends Error {
  constructor() {
    super('Actor cannot perform this destination operation');
    this.name = 'PaymentDestinationPermissionError';
  }
}

export class PaymentDestinationConflictError extends Error {
  constructor(
    public readonly code:
      | 'TRIP_ARCHIVED'
      | 'FUND_NOT_OPEN'
      | 'FINANCE_VERSION_CONFLICT'
      | 'DESTINATION_VERSION_CONFLICT'
      | 'DESTINATION_SCOPE_MISMATCH'
      | 'DESTINATION_TYPE_IMMUTABLE'
      | 'DESTINATION_INACTIVE'
      | 'INACTIVE_DEFAULT'
      | 'DEFAULT_CONTEXT_INVALID'
      | 'VERSION_EXHAUSTED',
  ) {
    super(code);
    this.name = 'PaymentDestinationConflictError';
  }
}

export class PaymentDestinationValidationError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid payment destination field: ${field}`);
    this.name = 'PaymentDestinationValidationError';
  }
}

const MAX_VERSION = 2147483647;
function conflict(code: PaymentDestinationConflictError['code']): never {
  throw new PaymentDestinationConflictError(code);
}
function version(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VERSION) {
    throw new PaymentDestinationValidationError('version');
  }
}
function canIncrement(value: number): void {
  version(value);
  if (value === MAX_VERSION) conflict('VERSION_EXHAUSTED');
}

function access(
  context: PaymentDestinationContext,
  expectedFinanceVersion: number,
  role: 'OWNER' | 'HOLDER',
): void {
  const requiredActor = role === 'OWNER' ? context.ownerUserId : context.holderUserId;
  if (
    context.actorUserId !== requiredActor ||
    !context.activeMemberUserIds.has(context.actorUserId)
  ) {
    throw new PaymentDestinationPermissionError();
  }
  if (context.tripArchived) conflict('TRIP_ARCHIVED');
  if (context.fundStatus !== 'OPEN') conflict('FUND_NOT_OPEN');
  version(context.financeVersion);
  version(expectedFinanceVersion);
  if (context.financeVersion !== expectedFinanceVersion) conflict('FINANCE_VERSION_CONFLICT');
}

function checkState(
  state: PaymentDestinationState,
  context: PaymentDestinationContext,
  expectedVersion: number,
): void {
  if (state.fundId !== context.fundId) conflict('DESTINATION_SCOPE_MISMATCH');
  version(state.version);
  version(expectedVersion);
  if (state.version !== expectedVersion) conflict('DESTINATION_VERSION_CONFLICT');
  assertValidFundDestination(state.configuration);
}

/** currentDefault must be the current ACTIVE default of this Fund/type, or explicit null. */
function defaultToDemote(
  configuration: FundDestination,
  context: PaymentDestinationContext,
  currentDefault: PaymentDestinationState | null,
  target?: PaymentDestinationState,
): DestinationChangePlan['demoteDefault'] {
  if (currentDefault === null) {
    if (target?.configuration.active && target.configuration.isDefault)
      conflict('DEFAULT_CONTEXT_INVALID');
    return null;
  }
  assertValidFundDestination(currentDefault.configuration);
  version(currentDefault.version);
  if (
    currentDefault.fundId !== context.fundId ||
    currentDefault.configuration.destinationType !== configuration.destinationType ||
    !currentDefault.configuration.active ||
    !currentDefault.configuration.isDefault
  )
    conflict('DEFAULT_CONTEXT_INVALID');
  if (target?.id === currentDefault.id) {
    const a = target.configuration;
    const b = currentDefault.configuration;
    if (
      target.version !== currentDefault.version ||
      !a.active ||
      !a.isDefault ||
      !sameRecipient(a, b)
    ) {
      conflict('DEFAULT_CONTEXT_INVALID');
    }
    return null;
  }
  if (target?.configuration.active && target.configuration.isDefault)
    conflict('DEFAULT_CONTEXT_INVALID');
  if (!configuration.active || !configuration.isDefault) return null;
  canIncrement(currentDefault.version);
  return { id: currentDefault.id, expectedVersion: currentDefault.version };
}

function sameRecipient(a: FundDestination, b: FundDestination): boolean {
  if (a.destinationType === 'VIETQR' && b.destinationType === 'VIETQR') {
    return (
      a.bankCode === b.bankCode &&
      a.accountNumber === b.accountNumber &&
      a.accountName === b.accountName
    );
  }
  return (
    a.destinationType === 'MOMO_SANDBOX' &&
    b.destinationType === 'MOMO_SANDBOX' &&
    a.momoPhone === b.momoPhone
  );
}

export function prepareCreatePaymentDestination(
  command: CreatePaymentDestinationCommand,
  context: PaymentDestinationContext,
  currentDefault: PaymentDestinationState | null,
): DestinationChangePlan {
  access(context, command.expectedFinanceVersion, 'OWNER');
  assertValidFundDestination(command.destination);
  if (!command.destination.active && command.destination.isDefault) conflict('INACTIVE_DEFAULT');
  canIncrement(context.financeVersion);
  return {
    configuration: { ...command.destination },
    changed: true,
    confirmation: 'CLEAR',
    demoteDefault: defaultToDemote(command.destination, context, currentDefault),
  };
}

export function prepareConfirmPaymentDestination(
  command: DestinationVersions,
  context: PaymentDestinationContext,
  state: PaymentDestinationState,
): DestinationChangePlan {
  access(context, command.expectedFinanceVersion, 'HOLDER');
  checkState(state, context, command.expectedVersion);
  if (!state.configuration.active) conflict('DESTINATION_INACTIVE');
  const changed = state.confirmedByHolderAt === null;
  if (changed) {
    canIncrement(context.financeVersion);
    canIncrement(state.version);
  }
  return {
    configuration: { ...state.configuration },
    changed,
    confirmation: changed ? 'SET' : 'KEEP',
    demoteDefault: null,
  };
}

function patchedConfiguration(patch: DestinationPatch, current: FundDestination): FundDestination {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(patch))
  )
    throw new PaymentDestinationValidationError('patch');
  const keys = Object.keys(patch);
  const fields = [
    'destinationType',
    'isDefault',
    'active',
    'bankCode',
    'accountNumber',
    'accountName',
    'momoPhone',
  ];
  if (keys.length === 0 || keys.some((key) => !fields.includes(key)))
    throw new PaymentDestinationValidationError('patch');
  if (Object.hasOwn(patch, 'destinationType')) {
    if (patch.destinationType !== 'VIETQR' && patch.destinationType !== 'MOMO_SANDBOX')
      throw new PaymentDestinationValidationError('destination_type');
    if (patch.destinationType !== current.destinationType) conflict('DESTINATION_TYPE_IMMUTABLE');
  }
  const incompatible =
    current.destinationType === 'VIETQR'
      ? ['momoPhone']
      : ['bankCode', 'accountNumber', 'accountName'];
  if (keys.some((key) => incompatible.includes(key)))
    throw new PaymentDestinationValidationError('patch');
  // Only own fields are applied. The discriminant was checked above, never converted.
  const candidate = { ...current, ...patch } as FundDestination;
  assertValidFundDestination(candidate);
  if (!candidate.active) {
    if (patch.isDefault === true) conflict('INACTIVE_DEFAULT');
    return { ...candidate, isDefault: false };
  }
  // Reactivation never restores an old default flag implicitly.
  if (!current.active && !Object.hasOwn(patch, 'isDefault'))
    return { ...candidate, isDefault: false };
  return candidate;
}

export function prepareUpdatePaymentDestination(
  command: UpdatePaymentDestinationCommand,
  context: PaymentDestinationContext,
  state: PaymentDestinationState,
  currentDefault: PaymentDestinationState | null,
): DestinationChangePlan {
  access(context, command.expectedFinanceVersion, 'OWNER');
  checkState(state, context, command.expectedVersion);
  const configuration = patchedConfiguration(command.patch, state.configuration);
  const recipientChanged = !sameRecipient(configuration, state.configuration);
  const changed =
    recipientChanged ||
    configuration.active !== state.configuration.active ||
    configuration.isDefault !== state.configuration.isDefault;
  const demoteDefault = defaultToDemote(configuration, context, currentDefault, state);
  if (changed) {
    canIncrement(context.financeVersion);
    canIncrement(state.version);
  }
  return {
    configuration,
    changed,
    demoteDefault,
    confirmation:
      recipientChanged || (!state.configuration.active && configuration.active) ? 'CLEAR' : 'KEEP',
  };
}
