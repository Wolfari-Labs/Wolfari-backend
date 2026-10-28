import { createHash } from 'node:crypto';
import { parseEventForConsume } from '@wolfari/contracts/events';

export const FINANCE_NOTIFICATION_QUEUE = 'wolfari.automation.finance-notifications.v1';
export const FINANCE_NOTIFICATION_CONSUMER = 'AutomationFinanceContributionInbox';
export const FINANCE_NOTIFICATION_ATTEMPT = 'x-finance-notification-attempt';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidFinanceNotificationEvent extends Error {
  constructor() {
    super('INVALID_FINANCE_NOTIFICATION_EVENT');
  }
}
export function recipientUuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value))
    throw new Error('FINANCE_NOTIFICATION_CONTEXT_UNAVAILABLE');
  return value.toLowerCase();
}
export function notificationEnabled(value: unknown): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('AUTOMATION_FINANCE_NOTIFICATION_ENABLED must be true or false');
}

export interface ContributionNotificationEvent {
  eventId: string;
  fundId: string;
  tripId: string;
  requestId: string;
  version: number;
  correlationId: string;
  contributionCount: number;
  fingerprint: string;
}

export interface ClosureNotificationEvent extends Omit<
  ContributionNotificationEvent,
  'requestId' | 'contributionCount'
> {
  closureId: string;
  snapshotHash: string;
}
export type FinanceNotificationEvent = ContributionNotificationEvent | ClosureNotificationEvent;

/** Preserve the original contribution projection/hash so processed events survive upgrades. */
export function financeNotificationEvent(value: unknown): FinanceNotificationEvent {
  try {
    const event = parseEventForConsume(value);
    if (event.event_type !== 'ClosureRequested') return contributionNotificationEvent(value);
    if (event.producer !== 'Finance' || event.aggregate_type !== 'Fund')
      throw new InvalidFinanceNotificationEvent();
    const result = {
      eventId: recipientUuid(event.event_id),
      fundId: recipientUuid(event.aggregate_id),
      tripId: recipientUuid(event.trip_id),
      closureId: recipientUuid(event.payload.closure_id),
      snapshotHash: event.payload.snapshot_hash as string,
      version: event.aggregate_version!,
      correlationId: recipientUuid(event.correlation_id),
    };
    return {
      ...result,
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            'ClosureRequested',
            result,
            event.occurred_at,
            event.operation_id ?? null,
            event.causation_id ?? null,
            event.actor_user_id ?? null,
            event.system_actor ?? null,
          ]),
        )
        .digest('hex'),
    };
  } catch {
    throw new InvalidFinanceNotificationEvent();
  }
}

/** Project known fields only; compatible additive event fields never become notification content. */
export function contributionNotificationEvent(value: unknown): ContributionNotificationEvent {
  try {
    const event = parseEventForConsume(value);
    if (
      event.producer !== 'Finance' ||
      event.event_type !== 'ContributionRequested' ||
      event.aggregate_type !== 'Fund'
    )
      throw new InvalidFinanceNotificationEvent();
    const payload = event.payload;
    const contributionIds = (payload.contribution_ids as unknown[]).map(recipientUuid).sort();
    if (new Set(contributionIds).size !== contributionIds.length)
      throw new InvalidFinanceNotificationEvent();
    const result = {
      eventId: recipientUuid(event.event_id),
      fundId: recipientUuid(event.aggregate_id),
      tripId: recipientUuid(event.trip_id),
      requestId: recipientUuid(payload.request_id),
      version: event.aggregate_version!,
      correlationId: recipientUuid(event.correlation_id),
      contributionCount: contributionIds.length,
    };
    return {
      ...result,
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            result,
            contributionIds,
            event.occurred_at,
            event.operation_id ?? null,
            event.causation_id ?? null,
            event.actor_user_id ?? null,
            event.system_actor ?? null,
          ]),
        )
        .digest('hex'),
    };
  } catch {
    throw new InvalidFinanceNotificationEvent();
  }
}
