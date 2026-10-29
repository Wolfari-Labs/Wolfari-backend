import { ContractValidationError, parseEventForPublish } from '@wolfari/contracts/events';

export type FinanceEvent = ReturnType<typeof parseEventForPublish>;
export interface FinanceOutboxRow {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: Date | string;
  producer: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  causation_id: string | null;
  operation_id: string | null;
  trip_id: string | null;
  actor_user_id: string | null;
  system_actor: string | null;
  payload: Record<string, unknown>;
}
const supported = new Set([
  'ContributionRequested',
  'ContributionUpdated',
  'ClosureRequested',
  'ClosureCancelled',
  'FinanceClosed',
]);
export function validateFinanceEvent(value: unknown): FinanceEvent {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('producer' in value) ||
    value.producer !== 'Finance' ||
    !('event_type' in value) ||
    typeof value.event_type !== 'string' ||
    !supported.has(value.event_type)
  )
    throw new ContractValidationError('INVALID_EVENT', 'Unsupported Finance outbox event');
  return parseEventForPublish(value);
}
export function storedFinanceEvent(row: FinanceOutboxRow): FinanceEvent {
  const occurred =
    row.occurred_at instanceof Date
      ? Number.isFinite(row.occurred_at.getTime())
        ? row.occurred_at.toISOString()
        : ''
      : row.occurred_at;
  if (
    typeof occurred !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(occurred)
  )
    throw new ContractValidationError('INVALID_EVENT', 'Invalid Finance event timestamp');
  return validateFinanceEvent({
    event_id: row.event_id,
    event_type: row.event_type,
    schema_version: row.schema_version,
    occurred_at: occurred,
    producer: row.producer,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    aggregate_version: row.aggregate_version,
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    operation_id: row.operation_id,
    trip_id: row.trip_id,
    actor_user_id: row.actor_user_id,
    system_actor: row.system_actor,
    payload: row.payload,
  });
}
