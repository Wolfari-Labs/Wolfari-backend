import { fail } from './trip.errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INT32 = 2_147_483_647;

export type PlanEditPolicy = 'OWNER_ONLY' | 'SELECTED_MEMBERS' | 'ALL_MEMBERS';
export type AccessAction =
  'TRIP_VIEW' | 'TRIP_UPDATE_METADATA' | 'PLAN_EDIT' | 'PLAN_POLICY_UPDATE';

export interface PlanPolicyView {
  policy: PlanEditPolicy;
  editor_member_ids: string[];
  membership_revision: number;
}

export function accessUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail('VALIDATION_FAILED', 400);
  return value.toLowerCase();
}

export function accessRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_INT32) {
    return fail('VALIDATION_FAILED', 400);
  }
  return Number(value);
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
  const normalized = value.map(accessUuid);
  if (new Set(normalized).size !== normalized.length) return fail('VALIDATION_FAILED', 400);
  return normalized.sort();
}

export const maximumRevision = MAX_INT32;
