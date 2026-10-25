import { AutomationV1 } from '@wolfari/contracts/grpc';
import { notificationFail } from './notification.errors';

export const notificationGroups = [
  'INVITATION',
  'PLAN',
  'PACKING',
  'CONTRIBUTION',
  'CLOSURE',
  'PRICE',
] as const;

export type NotificationGroup = (typeof notificationGroups)[number];
export type GroupOverride = { push?: boolean; email?: boolean };
export type PreferenceGroups = Partial<Record<NotificationGroup, GroupOverride>>;
export type DevicePlatform = 'IOS' | 'ANDROID' | 'WEB';
export type UnreadFilter = 'ALL' | 'UNREAD' | 'READ';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const groupFromProto: Partial<Record<AutomationV1.NotificationGroup, NotificationGroup>> = {
  [AutomationV1.NotificationGroup.NOTIFICATION_GROUP_INVITATION]: 'INVITATION',
  [AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PLAN]: 'PLAN',
  [AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PACKING]: 'PACKING',
  [AutomationV1.NotificationGroup.NOTIFICATION_GROUP_CONTRIBUTION]: 'CONTRIBUTION',
  [AutomationV1.NotificationGroup.NOTIFICATION_GROUP_CLOSURE]: 'CLOSURE',
  [AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PRICE]: 'PRICE',
};

const platformFromProto: Partial<Record<AutomationV1.DevicePlatform, DevicePlatform>> = {
  [AutomationV1.DevicePlatform.DEVICE_PLATFORM_IOS]: 'IOS',
  [AutomationV1.DevicePlatform.DEVICE_PLATFORM_ANDROID]: 'ANDROID',
  [AutomationV1.DevicePlatform.DEVICE_PLATFORM_WEB]: 'WEB',
};

export function notificationUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return notificationFail('VALIDATION_FAILED');
  return value.toLowerCase();
}

export function notificationVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    return notificationFail('VALIDATION_FAILED');
  return Number(value);
}

export function notificationPageLimit(value: unknown): number {
  const result = value === undefined || value === 0 ? 20 : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 100)
    return notificationFail('VALIDATION_FAILED');
  return result;
}

export function normalizePreferenceGroups(
  values: AutomationV1.NotificationGroupOverride[] | undefined,
): PreferenceGroups {
  if (!Array.isArray(values)) return notificationFail('VALIDATION_FAILED');
  const result: PreferenceGroups = {};
  for (const item of values) {
    const group = item ? groupFromProto[item.group ?? 0] : undefined;
    if (!group || Object.hasOwn(result, group)) return notificationFail('VALIDATION_FAILED');
    const hasPush = item.push !== undefined;
    const hasEmail = item.email !== undefined;
    if (!hasPush && !hasEmail) return notificationFail('VALIDATION_FAILED');
    result[group] = {
      ...(hasPush ? { push: item.push } : {}),
      ...(hasEmail ? { email: item.email } : {}),
    };
  }
  return result;
}

export function normalizePlatform(value: AutomationV1.DevicePlatform | undefined): DevicePlatform {
  return platformFromProto[value ?? 0] ?? notificationFail('VALIDATION_FAILED');
}

export function normalizeDeviceToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 4096 ||
    value !== value.trim() ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    return notificationFail('VALIDATION_FAILED');
  return value;
}

export function unreadFilter(value: boolean | undefined): UnreadFilter {
  if (value === undefined) return 'ALL';
  return value ? 'UNREAD' : 'READ';
}

export function parseStoredGroups(value: unknown): PreferenceGroups {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: PreferenceGroups = {};
  for (const group of notificationGroups) {
    const raw = (value as Record<string, unknown>)[group];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const override: GroupOverride = {};
    if (typeof item.push === 'boolean') override.push = item.push;
    if (typeof item.email === 'boolean') override.email = item.email;
    if (Object.keys(override).length) result[group] = override;
  }
  return result;
}

export function channelEnabled(
  globalEnabled: boolean,
  groups: PreferenceGroups,
  group: NotificationGroup,
  channel: keyof GroupOverride,
): boolean {
  return globalEnabled && (groups[group]?.[channel] ?? true);
}
