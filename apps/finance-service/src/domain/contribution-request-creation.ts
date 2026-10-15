import { ContributionPermissionDeniedError } from './contribution-permissions';
import {
  assertValidContributionRequest,
  InvalidContributionRequestError,
  type ContributionRequestContext,
  type ContributionRequestItem,
} from './contribution-request';

/** Internal command: the boundary parses UUIDs, money and instants before this check. */
export type CreateContributionRequestCommand = Readonly<{
  title: string;
  contributions: readonly ContributionRequestItem[];
  dueAt: Date | null;
  note: string | null;
  expectedFinanceVersion: number;
}>;

/** Current Trip authorization and stored Fund/destinations; never client-supplied roles. */
export type ContributionRequestCreationContext = ContributionRequestContext &
  Readonly<{
    actorUserId: string;
    ownerUserId: string;
    fundStatus: 'OPEN' | 'CLOSING' | 'CLOSED';
    financeVersion: number;
  }>;

export class ContributionRequestCreationConflictError extends Error {
  constructor(public readonly code: 'FUND_NOT_OPEN' | 'FINANCE_VERSION_CONFLICT') {
    super(
      code === 'FUND_NOT_OPEN'
        ? 'Creating a request requires an OPEN Fund'
        : 'Fund version has changed',
    );
    this.name = 'ContributionRequestCreationConflictError';
  }
}

/**
 * API078 / FR-FN02: validate a NEW request, without generating IDs or writing state.
 * Resolve receipt replay before validating a new command. The caller must obtain the Trip
 * guard for this Fund's Trip, read the Fund/destinations under lock, then atomically save
 * the OPEN request, PENDING contributions, destination snapshots, version, receipt,
 * audit and ContributionRequested outbox event. This check grants no durable permission.
 * Creating obligations does not credit the balance or create ledger entries.
 */
export function assertCanCreateContributionRequest(
  command: CreateContributionRequestCommand,
  context: ContributionRequestCreationContext,
): void {
  if (
    context.actorUserId !== context.ownerUserId ||
    !context.activeMemberUserIds.has(context.actorUserId)
  ) {
    throw new ContributionPermissionDeniedError(
      'Only the active Trip Owner can create a contribution request',
    );
  }
  if (context.fundStatus !== 'OPEN') {
    throw new ContributionRequestCreationConflictError('FUND_NOT_OPEN');
  }
  for (const version of [command.expectedFinanceVersion, context.financeVersion]) {
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) {
      throw new RangeError('Version must be a positive PostgreSQL integer');
    }
  }
  if (command.expectedFinanceVersion !== context.financeVersion) {
    throw new ContributionRequestCreationConflictError('FINANCE_VERSION_CONFLICT');
  }

  assertValidContributionRequestMetadata(command);
  assertValidContributionRequest(command.contributions, context);
}

/** Shared by the input parser and domain check; does not authorize creating a request. */
export function assertValidContributionRequestMetadata(
  command: Pick<CreateContributionRequestCommand, 'title' | 'note' | 'dueAt'>,
): void {
  // varchar(200) counts characters, not UTF-16 code units. Preserve the supplied text.
  if (
    typeof command.title !== 'string' ||
    command.title.trim().length === 0 ||
    [...command.title].length > 200 ||
    command.title.includes('\u0000')
  ) {
    throw new InvalidContributionRequestError('Title must contain 1 to 200 characters and no NUL');
  }
  if (
    command.note !== null &&
    (typeof command.note !== 'string' || command.note.includes('\u0000'))
  ) {
    throw new InvalidContributionRequestError('Note must be text without NUL or null');
  }
  if (
    command.dueAt !== null &&
    (!(command.dueAt instanceof Date) || !Number.isFinite(command.dueAt.getTime()))
  ) {
    throw new InvalidContributionRequestError('Due date must be a valid Date or null');
  }
}
