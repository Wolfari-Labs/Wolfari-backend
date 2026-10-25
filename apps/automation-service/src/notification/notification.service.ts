import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationV1 } from '@wolfari/contracts/grpc';
import { PriceWatchAccessService } from '../price-watch/price-watch-access.service';
import { NotificationCursor } from './notification.cursor';
import {
  normalizeDeviceToken,
  normalizePlatform,
  normalizePreferenceGroups,
  notificationPageLimit,
  notificationUuid,
  notificationVersion,
  unreadFilter,
} from './notification.domain';
import { notificationFail } from './notification.errors';
import {
  NotificationRepository,
  type NotificationPreferenceRecord,
  type NotificationRecord,
} from './notification.repository';

const MASKED_TITLE = 'Thông báo không còn khả dụng';
const MASKED_BODY = 'Nội dung này không còn khả dụng theo quyền hiện tại.';

@Injectable()
export class NotificationService {
  private readonly cursor: NotificationCursor;

  constructor(
    config: ConfigService,
    private readonly access: PriceWatchAccessService,
    private readonly repository: NotificationRepository,
  ) {
    this.cursor = new NotificationCursor(config.get<string>('AUTOMATION_CURSOR_SECRET') ?? '');
  }

  getPreference(request: AutomationV1.GetNotificationPreferencesRequest) {
    return this.repository.getPreference(notificationUuid(request.actor_user_id));
  }

  updatePreference(
    request: AutomationV1.UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferenceRecord> {
    if (typeof request.push_enabled !== 'boolean' || typeof request.email_enabled !== 'boolean')
      return notificationFail('VALIDATION_FAILED');
    return this.repository.updatePreference({
      userId: notificationUuid(request.actor_user_id),
      pushEnabled: request.push_enabled,
      emailEnabled: request.email_enabled,
      groupOverrides: normalizePreferenceGroups(request.group_overrides),
      expectedVersion: notificationVersion(request.expected_version),
    });
  }

  registerDevice(request: AutomationV1.RegisterDeviceRequest) {
    return this.repository.registerDevice({
      userId: notificationUuid(request.actor_user_id),
      platform: normalizePlatform(request.platform),
      token: normalizeDeviceToken(request.token),
    });
  }

  async deleteDevice(request: AutomationV1.DeleteDeviceRequest): Promise<void> {
    await this.repository.deleteDevice(
      notificationUuid(request.actor_user_id),
      notificationUuid(request.device_id),
    );
  }

  async listNotifications(
    request: AutomationV1.ListNotificationsRequest,
    correlationId: string,
  ): Promise<{ items: NotificationRecord[]; next_cursor: string | null }> {
    const userId = notificationUuid(request.actor_user_id);
    const limit = notificationPageLimit(request.limit);
    const unread = unreadFilter(request.unread);
    const after =
      request.cursor === undefined ? undefined : this.cursor.decode(request.cursor, userId, unread);
    const rows = await this.repository.listNotifications(userId, unread, limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const access = await this.tripAccess(items, userId, correlationId);
    return {
      items: items.map((item) => this.safeProjection(item, access)),
      next_cursor:
        rows.length > limit && last
          ? this.cursor.encode({
              scope: 'NOTIFICATIONS',
              user_id: userId,
              unread,
              sort_at: last.created_at,
              id: last.id,
            })
          : null,
    };
  }

  async markRead(
    request: AutomationV1.MarkNotificationReadRequest,
    correlationId: string,
  ): Promise<NotificationRecord> {
    const userId = notificationUuid(request.actor_user_id);
    const record = await this.repository.markRead(
      userId,
      notificationUuid(request.notification_id),
    );
    if (!record.trip_id) return record;
    const access = await this.tripAccess([record], userId, correlationId);
    return this.safeProjection(record, access);
  }

  private async tripAccess(
    items: NotificationRecord[],
    userId: string,
    correlationId: string,
  ): Promise<Map<string, boolean>> {
    const tripIds = [...new Set(items.flatMap((item) => (item.trip_id ? [item.trip_id] : [])))];
    const result = new Map<string, boolean>();
    for (let offset = 0; offset < tripIds.length; offset += 8) {
      const batch = tripIds.slice(offset, offset + 8);
      await Promise.all(
        batch.map(async (tripId) => {
          try {
            await this.access.get(tripId, userId, correlationId);
            result.set(tripId, true);
          } catch {
            result.set(tripId, false);
          }
        }),
      );
    }
    return result;
  }

  private safeProjection(
    value: NotificationRecord,
    access: Map<string, boolean>,
  ): NotificationRecord {
    if (!value.trip_id || access.get(value.trip_id) === true) return value;
    return {
      ...value,
      trip_id: null,
      source_id: null,
      title: MASKED_TITLE,
      body: MASKED_BODY,
    };
  }
}
