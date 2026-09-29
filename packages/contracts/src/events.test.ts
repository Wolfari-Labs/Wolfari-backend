import { describe, expect, it } from 'vitest';
import {
  ContractValidationError,
  EVENT_CATALOG,
  EVENT_TOPOLOGY,
  exportResultEventId,
  validateEventForConsume,
  validateEventForPublish,
} from './events';

const id = {
  event: '00000000-0000-4000-8000-000000000001',
  user: '00000000-0000-4000-8000-000000000002',
  trip: '00000000-0000-4000-8000-000000000003',
  aggregate: '00000000-0000-4000-8000-000000000004',
  invitation: '00000000-0000-4000-8000-000000000005',
  fund: '00000000-0000-4000-8000-000000000006',
  request: '00000000-0000-4000-8000-000000000007',
  contribution: '00000000-0000-4000-8000-000000000008',
  closure: '00000000-0000-4000-8000-000000000009',
  job: '00000000-0000-4000-8000-00000000000a',
  attempt: '00000000-0000-4000-8000-00000000000b',
  token: '00000000-0000-4000-8000-00000000000c',
};

const hash = 'a'.repeat(64);

function payload(eventType: string): Record<string, unknown> {
  switch (eventType) {
    case 'AccountStatusChanged': return { user_id: id.user, status: 'ACTIVE', user_version: 7 };
    case 'MemberInvited': return { invitation_id: id.invitation, trip_id: id.trip, invitation_version: 7 };
    case 'PlanUpdated': return { trip_id: id.trip, plan_version: 7, changed_entities: [], source_version: 1, tombstones: [] };
    case 'MemberLeft':
    case 'MemberRemoved':
    case 'MemberJoined': return { trip_id: id.trip, user_id: id.user, membership_revision: 7 };
    case 'TripArchived':
    case 'TripReopened': return { trip_id: id.trip, export_revision: 7 };
    case 'TripDeleted': return { trip_id: id.trip, export_revision: 7, deleted_at: '2026-09-23T10:00:00.000Z' };
    case 'ContributionRequested': return { fund_id: id.fund, trip_id: id.trip, request_id: id.request, contribution_ids: [id.contribution], finance_version: 7 };
    case 'ContributionUpdated': return { fund_id: id.fund, trip_id: id.trip, contribution_id: id.contribution, status: 'CONFIRMED', finance_version: 7 };
    case 'ClosureRequested': return { fund_id: id.fund, trip_id: id.trip, closure_id: id.closure, snapshot_hash: hash, finance_version: 7 };
    case 'ClosureCancelled':
    case 'FinanceClosed': return { fund_id: id.fund, trip_id: id.trip, closure_id: id.closure, finance_version: 7 };
    case 'GenerateExport': return { job_id: id.job, attempt_id: id.attempt, job_version: 7, snapshot_key: 'private/snapshot.json', snapshot_hash: hash, snapshot_schema_version: 1, format: 'XLSX', preset_version: 1, result_key: 'private/result.xlsx' };
    case 'ExportStarted': return { job_id: id.job, attempt_id: id.attempt };
    case 'ExportCompleted': return { job_id: id.job, attempt_id: id.attempt, result_key: 'private/result.xlsx', sha256: hash, mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 42, completed_at: '2026-09-23T10:00:00.000Z' };
    case 'ExportFailed': return { job_id: id.job, attempt_id: id.attempt, error_code: 'RENDER_FAILED', retryable: false };
    case 'AccountEmailRequested': return { user_id: id.user, token_id: id.token, purpose: 'VERIFY_EMAIL' };
    default: throw new Error(`Missing fixture for ${eventType}`);
  }
}

function event(eventType: string): Record<string, unknown> {
  const catalog = EVENT_CATALOG.find(entry => entry.event_type === eventType)!;
  const body = payload(eventType);
  const aggregateId = catalog.aggregate_id_field ? body[catalog.aggregate_id_field] : id.aggregate;
  return {
    event_id: id.event,
    event_type: eventType,
    schema_version: 1,
    occurred_at: '2026-09-23T10:00:00.000Z',
    producer: catalog.producer,
    aggregate_type: catalog.aggregate_type,
    aggregate_id: aggregateId,
    aggregate_version: 7,
    correlation_id: '00000000-0000-4000-8000-00000000000d',
    causation_id: null,
    operation_id: null,
    trip_id: 'trip_id' in body ? body.trip_id : null,
    actor_user_id: id.user,
    system_actor: null,
    payload: body,
  };
}

function errorCode(work: () => void): string | undefined {
  try { work(); } catch (error) { return error instanceof ContractValidationError ? error.code : undefined; }
  return undefined;
}

describe('event contracts', () => {
  it('validates fixtures for all 19 catalogued event types', () => {
    expect(EVENT_CATALOG).toHaveLength(19);
    for (const entry of EVENT_CATALOG) expect(() => validateEventForPublish(event(entry.event_type))).not.toThrow();
  });

  it('publishes the documented 15/1/3 topology and retry policy', () => {
    expect(EVENT_TOPOLOGY.queues.map(queue => queue.bindings.length)).toEqual([15, 1, 3]);
    expect(EVENT_TOPOLOGY.retry_delays_ms).toEqual([10_000, 30_000, 120_000, 300_000, 900_000]);
  });

  it('accepts added optional fields for consumers but not publishers', () => {
    const value = event('AccountStatusChanged');
    (value.payload as Record<string, unknown>).future_optional = 'supported';
    expect(() => validateEventForConsume(value)).not.toThrow();
    expect(errorCode(() => validateEventForPublish(value))).toBe('INVALID_EVENT');
  });

  it.each([
    ['unknown event', () => ({ ...event('AccountStatusChanged'), event_type: 'SomethingNew' }), 'UNKNOWN_EVENT'],
    ['unknown version', () => ({ ...event('AccountStatusChanged'), schema_version: 2 }), 'UNKNOWN_SCHEMA_VERSION'],
    ['invalid UUID', () => ({ ...event('AccountStatusChanged'), correlation_id: 'request-123' }), 'INVALID_EVENT'],
    ['both actors', () => ({ ...event('AccountStatusChanged'), system_actor: 'Automation' }), 'INVALID_EVENT'],
    ['no actor', () => ({ ...event('AccountStatusChanged'), actor_user_id: null }), 'INVALID_EVENT'],
    ['wrong producer', () => ({ ...event('AccountStatusChanged'), producer: 'Trip' }), 'INVALID_EVENT'],
    ['wrong payload', () => ({ ...event('MemberInvited'), payload: payload('AccountStatusChanged') }), 'INVALID_EVENT'],
    ['version mismatch', () => ({ ...event('AccountStatusChanged'), aggregate_version: 8 }), 'INVALID_EVENT'],
  ])('rejects %s with a classified error', (_name, fixture, code) => {
    expect(errorCode(() => validateEventForPublish(fixture()))).toBe(code);
  });

  it('rejects sensitive fields even when nested', () => {
    const value = event('AccountEmailRequested');
    (value.payload as Record<string, unknown>).delivery = { raw_callback: 'do-not-publish' };
    expect(() => validateEventForPublish(value)).toThrow(/Sensitive field/);
  });

  it('enforces non-retryable ExportFailed from the v1 catalog', () => {
    const value = event('ExportFailed');
    (value.payload as Record<string, unknown>).retryable = true;
    expect(errorCode(() => validateEventForPublish(value))).toBe('INVALID_EVENT');
  });

  it('creates stable UUIDv5 IDs per export job, attempt and terminal/progress type', () => {
    const first = exportResultEventId(id.job, id.attempt, 'ExportCompleted');
    expect(exportResultEventId(id.job, id.attempt, 'ExportCompleted')).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[14]).toBe('5');
    expect(exportResultEventId(id.job, id.attempt, 'ExportFailed')).not.toBe(first);
    expect(exportResultEventId(id.job, id.user, 'ExportCompleted')).not.toBe(first);
  });
});
