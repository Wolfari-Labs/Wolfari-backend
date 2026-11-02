import { describe, expect, it } from 'vitest';
import {
  storedFinanceEvent,
  validateFinanceEvent,
  type FinanceOutboxRow,
} from './finance-outbox.event';

const id = '10000000-0000-4000-8000-000000000001';
function row(): FinanceOutboxRow {
  return {
    event_id: id,
    event_type: 'ContributionUpdated',
    schema_version: 1,
    occurred_at: new Date('2026-10-25T12:00:00.123Z'),
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: id,
    aggregate_version: 7,
    correlation_id: id,
    causation_id: id,
    operation_id: id,
    trip_id: id,
    actor_user_id: id,
    system_actor: null,
    payload: {
      fund_id: id,
      trip_id: id,
      contribution_id: id,
      status: 'REVERSED',
      finance_version: 7,
    },
  };
}

describe('Finance outbox envelope validation', () => {
  it('preserves stored identity, occurrence, causality, version and payload without dispatch metadata', () => {
    const original = row();
    const before = structuredClone(original);
    const event = storedFinanceEvent({
      ...original,
      claim_owner: 'private-lease',
    } as FinanceOutboxRow);
    expect(event).toEqual({ ...before, occurred_at: '2026-10-25T12:00:00.123Z' });
    expect(event).not.toHaveProperty('claim_owner');
    expect(original).toEqual(before);
    expect(storedFinanceEvent(original)).toEqual(event);
  });

  it('preserves PostgreSQL microseconds without a lossy Date roundtrip', () => {
    expect(
      storedFinanceEvent({ ...row(), occurred_at: '2026-10-25T12:00:00.123456Z' }).occurred_at,
    ).toBe('2026-10-25T12:00:00.123456Z');
  });

  it.each([
    'ContributionRequested',
    'ContributionUpdated',
    'ClosureRequested',
    'ClosureCancelled',
    'FinanceClosed',
  ])('accepts existing Finance type %s', (eventType) => {
    const original = row();
    original.event_type = eventType;
    if (eventType === 'ContributionRequested')
      original.payload = {
        fund_id: id,
        trip_id: id,
        request_id: id,
        contribution_ids: [id],
        finance_version: 7,
      };
    else if (eventType.startsWith('Closure') || eventType === 'FinanceClosed')
      original.payload = {
        fund_id: id,
        trip_id: id,
        closure_id: id,
        finance_version: 7,
        ...(eventType === 'ClosureRequested' ? { snapshot_hash: 'a'.repeat(64) } : {}),
      };
    expect(storedFinanceEvent(original).event_type).toBe(eventType);
  });

  it.each([
    { producer: 'Trip' },
    { event_type: 'MemberJoined' },
    { schema_version: 2 },
    { aggregate_id: '20000000-0000-4000-8000-000000000001' },
    { aggregate_version: 8 },
    { trip_id: null },
    { actor_user_id: null },
    { system_actor: 'Worker' },
    { payload: { ...row().payload, account_number: 'PRIVATE' } },
    { payload: { ...row().payload, secret: 'PRIVATE' } },
    { occurred_at: new Date(NaN) },
  ])('rejects malformed or non-Finance envelope %j', (patch) => {
    expect(() => storedFinanceEvent({ ...row(), ...patch })).toThrow();
  });

  it('allows a system actor instead of a user actor without adding provider payload', () => {
    expect(
      storedFinanceEvent({ ...row(), actor_user_id: null, system_actor: 'MomoWebhook' }),
    ).toMatchObject({ actor_user_id: null, system_actor: 'MomoWebhook' });
  });

  it.each([null, [], {}, { producer: 'Finance', event_type: 'Unknown' }])(
    'validates unknown input before wire use',
    (value) => expect(() => validateFinanceEvent(value)).toThrow(),
  );
});
