import {
  assertCanCreateContributionRequest,
  type ContributionRequestCreationContext,
  type CreateContributionRequestCommand,
} from '../domain/contribution-request-creation';
import { InvalidContributionRequestError } from '../domain/contribution-request';
import type { PaymentDestinationRecord } from '../repositories/payment-destination.repository';

export type PreparedContributionRequest = Omit<CreateContributionRequestCommand, 'contributions'> &
  Readonly<{
    contributions: readonly Readonly<{
      memberUserId: string;
      amount: bigint;
      destination: PaymentDestinationRecord;
    }>[];
  }>;

function copyDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidContributionRequestError('Stored destination timestamp is invalid');
  }
  return new Date(value.getTime());
}

function requiredDetail(value: string | null): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
    throw new InvalidContributionRequestError('Stored destination payment details are incomplete');
  }
}

function copyDestination(record: PaymentDestinationRecord): PaymentDestinationRecord {
  if (!Number.isInteger(record.version) || record.version < 1 || record.version > 2147483647) {
    throw new InvalidContributionRequestError('Stored destination version is invalid');
  }
  switch (record.destinationType) {
    case 'VIETQR':
      requiredDetail(record.bankCode);
      requiredDetail(record.accountNumber);
      requiredDetail(record.accountName);
      break;
    case 'MOMO_SANDBOX':
      requiredDetail(record.momoPhone);
      break;
    default:
      throw new InvalidContributionRequestError('Stored destination type is unsupported');
  }
  return {
    id: record.id,
    fundId: record.fundId,
    destinationType: record.destinationType,
    bankCode: record.bankCode,
    accountNumber: record.accountNumber,
    accountName: record.accountName,
    momoPhone: record.momoPhone,
    active: record.active,
    isDefault: record.isDefault,
    version: record.version,
    confirmedByHolderAt:
      record.confirmedByHolderAt === null ? null : copyDate(record.confirmedByHolderAt),
    createdAt: copyDate(record.createdAt),
    updatedAt: copyDate(record.updatedAt),
  };
}

/**
 * Pure internal preparation for a NEW request, not the destination_snapshot JSON contract.
 * The caller supplies current trusted Trip context and stored destinations for this Fund.
 * No DB/RPC, generated IDs, receipt replay or writes. A future writer must obtain the Trip
 * guard, resolve replay, and supply freshly locked data before committing all effects.
 * The result contains private payment details; never log or expose it as an API response.
 */
export function prepareContributionRequest(
  command: CreateContributionRequestCommand,
  context: Omit<ContributionRequestCreationContext, 'destinations'>,
  destinations: readonly PaymentDestinationRecord[],
): PreparedContributionRequest {
  const byId = new Map<string, PaymentDestinationRecord>();
  for (const destination of destinations) {
    if (destination.fundId !== context.fundId) continue;
    if (byId.has(destination.id)) {
      throw new InvalidContributionRequestError('Stored destination IDs must be unique');
    }
    byId.set(destination.id, destination);
  }
  assertCanCreateContributionRequest(command, {
    ...context,
    destinations: [...byId.values()].map((record) => ({
      id: record.id,
      fundId: record.fundId,
      active: record.active,
      confirmedByHolderAt:
        record.confirmedByHolderAt === null
          ? null
          : copyDate(record.confirmedByHolderAt).toISOString(),
    })),
  });
  return {
    title: command.title,
    note: command.note,
    dueAt: command.dueAt === null ? null : new Date(command.dueAt.getTime()),
    expectedFinanceVersion: command.expectedFinanceVersion,
    contributions: command.contributions.map((item) => {
      const destination = byId.get(item.destinationId);
      if (!destination)
        throw new InvalidContributionRequestError('Selected destination is missing');
      return {
        memberUserId: item.memberUserId,
        amount: item.amount,
        destination: copyDestination(destination),
      };
    }),
  };
}
