import { assertVndAmount } from './money';

export type ContributionRequestItem = Readonly<{
  memberUserId: string;
  amount: bigint;
  destinationId: string;
}>;

/** A projection of stored destinations; confirmation is never supplied by the client. */
export type ContributionDestination = Readonly<{
  id: string;
  fundId: string;
  active: boolean;
  confirmedByHolderAt: string | null;
}>;

export type ContributionRequestContext = Readonly<{
  fundId: string;
  activeMemberUserIds: ReadonlySet<string>;
  destinations: readonly ContributionDestination[];
}>;

export class InvalidContributionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContributionRequestError';
  }
}

/**
 * Validate the allocation list for a new contribution request (ContributionInput / AC-FN02).
 * IDs must already be validated and normalized UUIDs at the input/persistence boundary.
 * The caller supplies current membership for this Fund's Trip via the Trip guard and reads
 * stored destinations under the Fund lock. It must also check Owner rights, OPEN lifecycle,
 * idempotency, and save the request, contributions and destination snapshots atomically.
 * This pure check creates no obligation, ledger entry or balance change.
 */
export function assertValidContributionRequest(
  items: readonly ContributionRequestItem[],
  context: ContributionRequestContext,
): void {
  if (items.length === 0) {
    throw new InvalidContributionRequestError(
      'A contribution request must contain at least one member',
    );
  }

  const memberIds = new Set<string>();
  const eligibleDestinationIds = new Set(
    context.destinations
      .filter(
        (destination) =>
          destination.fundId === context.fundId &&
          destination.active &&
          destination.confirmedByHolderAt !== null,
      )
      .map((destination) => destination.id),
  );

  for (const item of items) {
    if (memberIds.has(item.memberUserId)) {
      throw new InvalidContributionRequestError(
        'A member can appear only once in a contribution request',
      );
    }
    memberIds.add(item.memberUserId);

    if (!context.activeMemberUserIds.has(item.memberUserId)) {
      throw new InvalidContributionRequestError(
        'Every contribution member must be active in the Trip',
      );
    }

    assertVndAmount(item.amount);
    if (item.amount === 0n) {
      throw new RangeError('Contribution amount must be greater than zero');
    }

    if (!eligibleDestinationIds.has(item.destinationId)) {
      throw new InvalidContributionRequestError(
        'The destination must belong to the Fund, be active and be confirmed by its Holder',
      );
    }
  }
}
