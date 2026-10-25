import { AutomationV1 } from '@wolfari/contracts/grpc';
import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service';
import type { NotificationRecord } from './notification.repository';

const userId = '11111111-1111-4111-8111-111111111111';
const tripId = '22222222-2222-4222-8222-222222222222';
const notificationId = '33333333-3333-4333-8333-333333333333';

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: notificationId,
    trip_id: tripId,
    type: 'PRICE_ALERT',
    title: 'Giá vé đã giảm',
    body: 'Giá tham khảo 100 VND.',
    source_id: '44444444-4444-4444-8444-444444444444',
    status: 'AVAILABLE',
    created_at: '2026-10-22T00:00:00.000Z',
    read_at: null,
    ...overrides,
  };
}

function setup(canRead = true) {
  const repository = {
    getPreference: vi.fn(),
    updatePreference: vi.fn(),
    registerDevice: vi.fn(),
    deleteDevice: vi.fn(),
    listNotifications: vi.fn(),
    markRead: vi.fn(),
  };
  const access = {
    get: canRead
      ? vi.fn().mockResolvedValue({ state: 'ACTIVE' })
      : vi.fn().mockRejectedValue(new Error('denied')),
  };
  const service = new NotificationService(
    { get: () => 's'.repeat(32) } as never,
    access as never,
    repository as never,
  );
  return { service, repository, access };
}

describe('NotificationService', () => {
  it('requires complete preference fields and passes normalized groups', async () => {
    const { service, repository } = setup();
    repository.updatePreference.mockResolvedValue({ version: 2 });
    await expect(
      service.updatePreference({
        actor_user_id: userId,
        push_enabled: true,
        email_enabled: false,
        expected_version: 1,
        group_overrides: [
          {
            group: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PRICE,
            push: false,
          },
        ],
      }),
    ).resolves.toEqual({ version: 2 });
    expect(repository.updatePreference).toHaveBeenCalledWith({
      userId,
      pushEnabled: true,
      emailEnabled: false,
      expectedVersion: 1,
      groupOverrides: { PRICE: { push: false } },
    });
    expect(() =>
      service.updatePreference({
        actor_user_id: userId,
        email_enabled: true,
        expected_version: 1,
        group_overrides: [],
      }),
    ).toThrowError('VALIDATION_FAILED');
  });

  it('masks Trip notification content when current access cannot be confirmed', async () => {
    const { service, repository } = setup(false);
    repository.listNotifications.mockResolvedValue([record()]);
    const result = await service.listNotifications(
      { actor_user_id: userId, limit: 20 },
      '55555555-5555-4555-8555-555555555555',
    );
    expect(result.items[0]).toMatchObject({
      trip_id: null,
      source_id: null,
      title: 'Thông báo không còn khả dụng',
    });
    expect(JSON.stringify(result)).not.toContain('100 VND');
  });

  it('keeps non-Trip content and accessible Trip content', async () => {
    const { service, repository, access } = setup(true);
    repository.listNotifications.mockResolvedValue([
      record(),
      record({ id: '66666666-6666-4666-8666-666666666666', trip_id: null }),
    ]);
    const result = await service.listNotifications(
      { actor_user_id: userId, limit: 20, unread: false },
      '55555555-5555-4555-8555-555555555555',
    );
    expect(result.items.map((item) => item.title)).toEqual(['Giá vé đã giảm', 'Giá vé đã giảm']);
    expect(access.get).toHaveBeenCalledTimes(1);
    expect(repository.listNotifications).toHaveBeenCalledWith(userId, 'READ', 21, undefined);
  });

  it('marks only through the Self-scoped repository and masks the returned projection', async () => {
    const { service, repository } = setup(false);
    repository.markRead.mockResolvedValue(record({ read_at: '2026-10-22T01:00:00.000Z' }));
    await expect(
      service.markRead(
        { actor_user_id: userId, notification_id: notificationId },
        '55555555-5555-4555-8555-555555555555',
      ),
    ).resolves.toMatchObject({ read_at: '2026-10-22T01:00:00.000Z', trip_id: null });
    expect(repository.markRead).toHaveBeenCalledWith(userId, notificationId);
  });
});
