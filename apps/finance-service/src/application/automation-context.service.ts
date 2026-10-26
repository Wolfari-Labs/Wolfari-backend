import { Inject, Injectable } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { CommonV1, FinanceV1, type TripV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid, UUID } from '../finance.errors';
import {
  FinanceAutomationContextRepository,
  type AutomationContextSnapshot,
  type AutomationSourceType,
  type AutomationCandidate,
} from '../repositories/automation-context.repository';
import { FinanceTripAccess } from './fund-query.service';

const sourceTypes: readonly AutomationSourceType[] = [
  'CONTRIBUTION_REQUEST',
  'CONTRIBUTION_DUE',
  'CONTRIBUTION_REVIEW',
  'CLOSURE',
];
function unavailable(): never {
  throw new FinanceReadError('SERVICE_UNAVAILABLE');
}
function withinDeadline(deadline: number): void {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) unavailable();
}
function trustedDenial(error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    !('details' in error) ||
    !('code' in error) ||
    typeof error.details !== 'string'
  )
    return false;
  try {
    const envelope: unknown = JSON.parse(error.details);
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      !('code' in envelope)
    )
      return false;
    return (
      (error.code === status.NOT_FOUND && envelope.code === 'RESOURCE_NOT_FOUND') ||
      (error.code === status.PERMISSION_DENIED && envelope.code === 'PERMISSION_DENIED')
    );
  } catch {
    return false;
  }
}
function joinedNanos(value: { seconds?: string; nanos?: number } | undefined): bigint {
  if (
    !value ||
    typeof value.seconds !== 'string' ||
    !/^-?\d{1,12}$/.test(value.seconds) ||
    !Number.isInteger(value.nanos) ||
    Number(value.nanos) < 0 ||
    Number(value.nanos) > 999999999
  )
    return unavailable();
  const seconds = BigInt(value.seconds);
  if (seconds < -62135596800n || seconds > 253402300799n) return unavailable();
  return seconds * 1000000000n + BigInt(value.nanos!);
}
function currentRecipient(
  response: TripV1.GetAccessContextResponse,
  snapshot: AutomationContextSnapshot,
  candidate: AutomationCandidate,
): boolean {
  const context = response?.context;
  const membership = context?.membership;
  const revisions = context?.revisions;
  if (
    !context ||
    !membership ||
    context.trip_id !== snapshot.tripId ||
    membership.trip_id !== snapshot.tripId ||
    membership.user_id !== candidate.userId ||
    typeof membership.id !== 'string' ||
    !UUID.test(membership.id) ||
    typeof context.allowed !== 'boolean' ||
    typeof context.can_read_trip !== 'boolean' ||
    ![
      CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER,
      CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
    ].includes(membership.role!) ||
    ![CommonV1.TripState.TRIP_STATE_ACTIVE, CommonV1.TripState.TRIP_STATE_ARCHIVED].includes(
      context.trip_state!,
    ) ||
    !revisions ||
    ![revisions.plan_version, revisions.membership_revision, revisions.export_revision].every(
      (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 2147483647,
    )
  )
    return unavailable();
  const joined = joinedNanos(membership.joined_at);
  // Trip currently truncates joined_at to milliseconds. Exclude an ambiguous same-ms rejoin.
  const remainder = ((joined % 1000000n) + 1000000n) % 1000000n;
  const latestJoined = joined - remainder + 999999n;
  if (membership.left_at !== undefined) joinedNanos(membership.left_at);
  return (
    context.allowed &&
    context.can_read_trip &&
    context.trip_state === CommonV1.TripState.TRIP_STATE_ACTIVE &&
    membership.left_at === undefined &&
    (candidate.cutoffMicros === null || latestJoined <= BigInt(candidate.cutoffMicros) * 1000n)
  );
}
function dueTimestamp(dueAt: string): { seconds: string; nanos: number } {
  const milliseconds = new Date(dueAt).getTime();
  return {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: (((milliseconds % 1000) + 1000) % 1000) * 1000000,
  };
}

@Injectable()
export class FinanceAutomationContextService {
  constructor(
    @Inject(FinanceAutomationContextRepository)
    private readonly repository: Pick<FinanceAutomationContextRepository, 'find'>,
    @Inject(FinanceTripAccess)
    private readonly trip: Pick<FinanceTripAccess, 'getAccessContext'>,
  ) {}

  async get(
    request: FinanceV1.GetAutomationContextRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.GetAutomationContextResponse> {
    const fundId = readUuid(request.fund_id),
      sourceId = readUuid(request.source_id);
    if (!sourceTypes.includes(request.source_type as AutomationSourceType))
      throw new FinanceReadError('VALIDATION_FAILED');
    const sourceType = request.source_type as AutomationSourceType;
    withinDeadline(deadline);
    const read = async () => {
      try {
        const snapshot = await this.repository.find(fundId, sourceType, sourceId, deadline);
        withinDeadline(deadline);
        return snapshot;
      } catch {
        return unavailable();
      }
    };
    const snapshot = await read();
    if (!snapshot) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const fingerprint = JSON.stringify(snapshot);
    const accepted = new Set<string>();
    let cursor = 0;
    let failed = false;
    const check = async () => {
      while (!failed && cursor < snapshot.candidates.length) {
        const candidate = snapshot.candidates[cursor++]!;
        try {
          withinDeadline(deadline);
          let response: TripV1.GetAccessContextResponse;
          try {
            response = await this.trip.getAccessContext(
              { trip_id: snapshot.tripId, user_id: candidate.userId, action: 'TRIP_VIEW' },
              correlation,
              deadline,
            );
          } catch (error) {
            withinDeadline(deadline);
            if (trustedDenial(error)) continue;
            return unavailable();
          }
          withinDeadline(deadline);
          if (currentRecipient(response, snapshot, candidate)) accepted.add(candidate.userId);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, snapshot.candidates.length) }, check));
    withinDeadline(deadline);
    const current = await read();
    if (!current || JSON.stringify(current) !== fingerprint) return unavailable();
    const recipients = snapshot.candidates
      .filter((candidate) => accepted.has(candidate.userId))
      .map((candidate) => ({ user_id: candidate.userId }));
    return {
      finance_version: snapshot.financeVersion,
      status: {
        OPEN: FinanceV1.FundStatus.FUND_STATUS_OPEN,
        CLOSING: FinanceV1.FundStatus.FUND_STATUS_CLOSING,
        CLOSED: FinanceV1.FundStatus.FUND_STATUS_CLOSED,
      }[snapshot.fundStatus],
      authorized_recipients: recipients,
      due_at:
        recipients.length &&
        snapshot.eligible &&
        snapshot.dueAt &&
        (sourceType === 'CONTRIBUTION_REQUEST' || sourceType === 'CONTRIBUTION_DUE')
          ? dueTimestamp(snapshot.dueAt)
          : undefined,
    };
  }
}
