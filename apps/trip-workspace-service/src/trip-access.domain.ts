import { fail } from './trip.errors';
import { uuid } from './trip-common';

export {
  uuid as accessUuid,
  positiveRevision as accessRevision,
  MAX_INT32 as maximumRevision,
} from './trip-common';

export type PlanEditPolicy = 'OWNER_ONLY' | 'SELECTED_MEMBERS' | 'ALL_MEMBERS';
export type AccessAction =
  'TRIP_VIEW' | 'TRIP_UPDATE_METADATA' | 'PLAN_EDIT' | 'PLAN_POLICY_UPDATE';

export interface PlanPolicyView {
  policy: PlanEditPolicy;
  editor_member_ids: string[];
  membership_revision: number;
}

export function accessAction(value: unknown): AccessAction {
  if (
    value !== 'TRIP_VIEW' &&
    value !== 'TRIP_UPDATE_METADATA' &&
    value !== 'PLAN_EDIT' &&
    value !== 'PLAN_POLICY_UPDATE'
  ) {
    return fail('VALIDATION_FAILED', 400);
  }
  return value;
}

export function planEditPolicy(value: unknown): PlanEditPolicy {
  if (value !== 'OWNER_ONLY' && value !== 'SELECTED_MEMBERS' && value !== 'ALL_MEMBERS') {
    return fail('VALIDATION_FAILED', 400);
  }
  return value;
}

export function editorMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return fail('VALIDATION_FAILED', 400);
  const normalized = value.map(uuid);
  if (new Set(normalized).size !== normalized.length) return fail('VALIDATION_FAILED', 400);
  return normalized.sort();
}
