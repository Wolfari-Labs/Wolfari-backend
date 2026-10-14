import { CommonV1 } from '@wolfari/contracts/grpc';
import { digest, fail, positiveRevision, uuid } from '../trip-common';
import { protobufTimestamp } from '../grpc-common';

export type LifecycleCommand = 'LEAVE_MEMBER' | 'REMOVE_MEMBER';
export type Command = {
  operationId: string;
  actorUserId: string;
  tripId: string;
  reason: string;
  expectedRevision: number;
  command: LifecycleCommand;
  memberId?: string;
};
export type Intent = Command & {
  version: 1;
  targetMemberId: string;
  targetUserId: string;
  correlationId: string;
  authorizationContext: CommonV1.AuthorizationContext;
};
export type LifecycleRow = {
  operation_id: string;
  trip_id: string;
  actor_user_id: string;
  operation_type: LifecycleCommand;
  request_hash: string;
  state: keyof typeof states;
  command_payload: Intent;
  outcome: CommonV1.OperationOutcome | null;
  retry_count: number;
  next_retry_at: Date | null;
};
export const states = {
  PROCESSING: CommonV1.OperationState.OPERATION_STATE_PROCESSING,
  PENDING_RECOVERY: CommonV1.OperationState.OPERATION_STATE_PENDING_RECOVERY,
  SUCCEEDED: CommonV1.OperationState.OPERATION_STATE_SUCCEEDED,
  FAILED: CommonV1.OperationState.OPERATION_STATE_FAILED,
  NEEDS_REVIEW: CommonV1.OperationState.OPERATION_STATE_NEEDS_REVIEW,
};
export const terminal = (row: LifecycleRow) => row.state === 'SUCCEEDED' || row.state === 'FAILED';
export const isLifecycle = (value: string) => value === 'LEAVE_MEMBER' || value === 'REMOVE_MEMBER';
export const retryDelays = [10, 30, 120, 300, 900] as const;
export function command(input: Record<string, unknown>, kind: LifecycleCommand): Command {
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000)
    return fail('VALIDATION_FAILED', 400);
  return {
    command: kind,
    operationId: uuid(input.operation_id),
    actorUserId: uuid(input.actor_user_id),
    tripId: uuid(input.trip_id),
    reason: input.reason.trim(),
    expectedRevision: positiveRevision(input.expected_membership_revision),
    ...(kind === 'REMOVE_MEMBER' ? { memberId: uuid(input.member_id) } : {}),
  };
}
export function requestHash(input: Command, targetMemberId: string): string {
  return digest({
    version: 1,
    command: input.command,
    actor: input.actorUserId,
    trip: input.tripId,
    target: targetMemberId,
    reason: input.reason,
    expected_membership_revision: input.expectedRevision,
  });
}
export function operationView(row: LifecycleRow): CommonV1.Operation {
  if (!isLifecycle(row.operation_type) || !(row.state in states))
    throw new Error('Invalid lifecycle receipt');
  return {
    operation_id: row.operation_id,
    trip_id: row.trip_id,
    state: states[row.state],
    // Never expose Finance blocking_ids, finance_version, closure_effect or stored intent.
    outcome: row.outcome
      ? { status: row.outcome.status, blocking_ids: [], error_code: row.outcome.error_code }
      : undefined,
    error_code: row.outcome?.error_code,
    next_retry_at: row.next_retry_at
      ? protobufTimestamp(row.next_retry_at.toISOString())
      : undefined,
  };
}
export function verifyReplay(row: LifecycleRow, input: Command) {
  if (row.actor_user_id !== input.actorUserId) return fail('RESOURCE_NOT_FOUND', 404);
  if (
    !isLifecycle(row.operation_type) ||
    row.command_payload?.version !== 1 ||
    row.trip_id !== input.tripId ||
    row.operation_type !== input.command ||
    (input.memberId && input.memberId !== row.command_payload.targetMemberId) ||
    requestHash(input, row.command_payload.targetMemberId) !== row.request_hash
  )
    return fail('IDEMPOTENCY_CONFLICT', 409);
}
export function validateReceipt(
  row: LifecycleRow,
  receipt: CommonV1.Receipt,
): CommonV1.OperationOutcome {
  const outcome = receipt.outcome;
  if (
    receipt.operation_id !== row.operation_id ||
    receipt.request_hash !== row.request_hash ||
    !receipt.completed_at ||
    !outcome ||
    ![
      CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED,
      CommonV1.ReceiptStatus.RECEIPT_STATUS_REJECTED,
      CommonV1.ReceiptStatus.RECEIPT_STATUS_CANCELLED,
    ].includes(outcome.status!) ||
    outcome.closure_effect ||
    (outcome.error_code &&
      !['FINANCE_OBLIGATION_BLOCKED', 'STATE_CONFLICT', 'VERSION_CONFLICT'].includes(
        outcome.error_code,
      )) ||
    (outcome.status === CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED && outcome.error_code)
  )
    throw new Error('Invalid Finance lifecycle receipt');
  return {
    status: outcome.status,
    blocking_ids: [],
    error_code:
      outcome.status === CommonV1.ReceiptStatus.RECEIPT_STATUS_COMMITTED
        ? undefined
        : (outcome.error_code ?? 'STATE_CONFLICT'),
  };
}
