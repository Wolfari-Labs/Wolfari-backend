import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status, type Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { AutomationV1, RPC_CATALOG } from '@wolfari/contracts/grpc';
import { timingSafeEqual } from 'node:crypto';
import { notificationGroups, type NotificationGroup } from '../notification/notification.domain';
import { NotificationError } from '../notification/notification.errors';
import type {
  DeviceRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
} from '../notification/notification.repository';
import { NotificationService } from '../notification/notification.service';
import { PriceWatchError } from './price-watch.errors';
import type { NormalizedPriceQuery, WatchStatus } from './price-watch.domain';
import type { ObservationRecord, PriceWatchRecord } from './price-watch.repository';
import { PriceWatchService } from './price-watch.service';

const CORRELATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusProto: Record<WatchStatus, AutomationV1.PriceWatchStatus> = {
  ACTIVE: AutomationV1.PriceWatchStatus.PRICE_WATCH_STATUS_ACTIVE,
  PAUSED: AutomationV1.PriceWatchStatus.PRICE_WATCH_STATUS_PAUSED,
  EXPIRED: AutomationV1.PriceWatchStatus.PRICE_WATCH_STATUS_EXPIRED,
  STOPPED: AutomationV1.PriceWatchStatus.PRICE_WATCH_STATUS_STOPPED,
};

function timestamp(value: string) {
  const milliseconds = new Date(value).getTime();
  return {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  };
}

function query(value: NormalizedPriceQuery): AutomationV1.PriceQueryView {
  return {
    provider: value.provider,
    transport_type: value.transport_type,
    origin: value.origin,
    destination: value.destination,
    departure_date: value.departure_date,
    return_date: value.return_date ?? undefined,
    journey_type:
      value.journey_type === 'ONE_WAY'
        ? AutomationV1.JourneyType.JOURNEY_TYPE_ONE_WAY
        : AutomationV1.JourneyType.JOURNEY_TYPE_ROUND_TRIP,
    passengers: { adults: value.adults, children: value.children, infants: value.infants },
    cabin_class: value.cabin_class,
    currency: value.currency,
    departure_at: timestamp(value.departure_at),
  };
}

function watch(value: PriceWatchRecord): AutomationV1.PriceWatchView {
  return {
    id: value.id,
    trip_id: value.trip_id,
    user_id: value.user_id,
    query_group_id: value.query_group_id,
    threshold_price: value.threshold_price,
    currency: value.currency,
    status: statusProto[value.status],
    status_reason: value.status_reason ?? undefined,
    version: value.version,
    expires_at: timestamp(value.expires_at),
    last_alert_price: value.last_alert_price ?? undefined,
    last_alert_at: value.last_alert_at ? timestamp(value.last_alert_at) : undefined,
    normalized_query: query(value.query),
    created_at: timestamp(value.created_at),
    updated_at: timestamp(value.updated_at),
  };
}

export function safeFareMetadata(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  const source = value as Record<string, unknown>;
  const result: Record<string, string | null> = {};
  for (const key of [
    'provider_fare_id',
    'carrier_code',
    'fare_class',
    'baggage_summary',
  ] as const) {
    const item = source[key];
    if (item === null || typeof item === 'string') result[key] = item;
  }
  return JSON.stringify(result);
}

function observation(value: ObservationRecord): AutomationV1.PriceObservationView {
  return {
    id: value.id,
    price: value.price,
    currency: value.currency,
    provider: value.provider,
    observed_at: timestamp(value.observed_at),
    fetched_at: timestamp(value.fetched_at),
    fare_metadata_json: safeFareMetadata(value.fare_metadata),
  };
}

const notificationGroupProto: Record<NotificationGroup, AutomationV1.NotificationGroup> = {
  INVITATION: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_INVITATION,
  PLAN: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PLAN,
  PACKING: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PACKING,
  CONTRIBUTION: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_CONTRIBUTION,
  CLOSURE: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_CLOSURE,
  PRICE: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PRICE,
};

const devicePlatformProto = {
  IOS: AutomationV1.DevicePlatform.DEVICE_PLATFORM_IOS,
  ANDROID: AutomationV1.DevicePlatform.DEVICE_PLATFORM_ANDROID,
  WEB: AutomationV1.DevicePlatform.DEVICE_PLATFORM_WEB,
} as const;

function preference(value: NotificationPreferenceRecord): AutomationV1.NotificationPreferenceView {
  return {
    push_enabled: value.push_enabled,
    email_enabled: value.email_enabled,
    group_overrides: notificationGroups.flatMap((group) => {
      const override = value.group_overrides[group];
      return override
        ? [{ group: notificationGroupProto[group], push: override.push, email: override.email }]
        : [];
    }),
    version: value.version,
  };
}

function device(value: DeviceRecord): AutomationV1.DeviceView {
  return {
    id: value.id,
    platform: devicePlatformProto[value.platform],
    active: value.active,
    last_seen_at: timestamp(value.last_seen_at),
  };
}

function notification(value: NotificationRecord): AutomationV1.NotificationView {
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    body: value.body,
    trip_id: value.trip_id ?? undefined,
    source_id: value.source_id ?? undefined,
    status: AutomationV1.NotificationStatus.NOTIFICATION_STATUS_AVAILABLE,
    created_at: timestamp(value.created_at),
    read_at: value.read_at ? timestamp(value.read_at) : undefined,
  };
}

function grpcStatus(error: PriceWatchError | NotificationError): status {
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return status.INVALID_ARGUMENT;
    case 'RESOURCE_NOT_FOUND':
      return status.NOT_FOUND;
    case 'PERMISSION_DENIED':
      return status.PERMISSION_DENIED;
    case 'VERSION_CONFLICT':
      return status.ABORTED;
    case 'STATE_CONFLICT':
      return status.FAILED_PRECONDITION;
    case 'IDEMPOTENCY_CONFLICT':
      return status.ALREADY_EXISTS;
    case 'SERVICE_UNAVAILABLE':
      return status.UNAVAILABLE;
  }
}

@Controller()
@AutomationV1.AutomationServiceControllerMethods()
export class PriceWatchGrpcController implements AutomationV1.AutomationServiceController {
  constructor(
    private readonly service: PriceWatchService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
  ) {}

  private authorize(method: string, metadata?: Metadata): string {
    const caller = String(metadata?.get('x-caller-service')[0] ?? '');
    const secret = String(metadata?.get('x-service-secret')[0] ?? '');
    const correlation = String(metadata?.get('x-correlation-id')[0] ?? '');
    const expected = this.config.get<string>('GATEWAY_AUTOMATION_SECRET') ?? '';
    const left = Buffer.from(secret);
    const right = Buffer.from(expected);
    const entry = RPC_CATALOG.find(
      (item) =>
        item.package === 'wolfari.automation.v1' &&
        item.service === 'AutomationService' &&
        item.method === method,
    );
    if (
      caller !== 'ApiGateway' ||
      !entry?.callers.includes(caller) ||
      !CORRELATION.test(correlation) ||
      right.length < 32 ||
      left.length !== right.length ||
      !timingSafeEqual(left, right)
    )
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Caller is not authorized',
      });
    return correlation.toLowerCase();
  }

  private async execute<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PriceWatchError || error instanceof NotificationError) {
        throw new RpcException({
          code: grpcStatus(error),
          message: JSON.stringify({ code: error.code, details: error.details }),
        });
      }
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', details: null }),
      });
    }
  }

  getNotificationPreferences(
    request: AutomationV1.GetNotificationPreferencesRequest,
    metadata?: Metadata,
  ) {
    this.authorize('GetNotificationPreferences', metadata);
    return this.execute(async () => ({
      preference: preference(await this.notifications.getPreference(request)),
    }));
  }

  updateNotificationPreferences(
    request: AutomationV1.UpdateNotificationPreferencesRequest,
    metadata?: Metadata,
  ) {
    this.authorize('UpdateNotificationPreferences', metadata);
    return this.execute(async () => ({
      preference: preference(await this.notifications.updatePreference(request)),
    }));
  }

  registerDevice(request: AutomationV1.RegisterDeviceRequest, metadata?: Metadata) {
    this.authorize('RegisterDevice', metadata);
    return this.execute(async () => ({
      device: device(await this.notifications.registerDevice(request)),
    }));
  }

  deleteDevice(request: AutomationV1.DeleteDeviceRequest, metadata?: Metadata) {
    this.authorize('DeleteDevice', metadata);
    return this.execute(async () => {
      await this.notifications.deleteDevice(request);
      return {};
    });
  }

  listNotifications(request: AutomationV1.ListNotificationsRequest, metadata?: Metadata) {
    const correlation = this.authorize('ListNotifications', metadata);
    return this.execute(async () => {
      const result = await this.notifications.listNotifications(request, correlation);
      return {
        items: result.items.map(notification),
        next_cursor: result.next_cursor ?? undefined,
      };
    });
  }

  markNotificationRead(request: AutomationV1.MarkNotificationReadRequest, metadata?: Metadata) {
    const correlation = this.authorize('MarkNotificationRead', metadata);
    return this.execute(async () => ({
      notification: notification(await this.notifications.markRead(request, correlation)),
    }));
  }

  createPriceWatch(request: AutomationV1.CreatePriceWatchRequest, metadata?: Metadata) {
    const correlation = this.authorize('CreatePriceWatch', metadata);
    return this.execute(async () => ({
      watch: watch(await this.service.create(request, correlation)),
    }));
  }

  listPriceWatches(request: AutomationV1.ListPriceWatchesRequest, metadata?: Metadata) {
    const correlation = this.authorize('ListPriceWatches', metadata);
    return this.execute(async () => {
      const result = await this.service.list(request, correlation);
      return { items: result.items.map(watch), next_cursor: result.next_cursor ?? undefined };
    });
  }

  updatePriceWatch(request: AutomationV1.UpdatePriceWatchRequest, metadata?: Metadata) {
    const correlation = this.authorize('UpdatePriceWatch', metadata);
    return this.execute(async () => ({
      watch: watch(await this.service.update(request, correlation)),
    }));
  }

  pausePriceWatch(request: AutomationV1.PausePriceWatchRequest, metadata?: Metadata) {
    const correlation = this.authorize('PausePriceWatch', metadata);
    return this.execute(async () => ({
      watch: watch(await this.service.changeStatus('PAUSE', request, correlation)),
    }));
  }

  resumePriceWatch(request: AutomationV1.ResumePriceWatchRequest, metadata?: Metadata) {
    const correlation = this.authorize('ResumePriceWatch', metadata);
    return this.execute(async () => ({
      watch: watch(await this.service.changeStatus('RESUME', request, correlation)),
    }));
  }

  stopPriceWatch(request: AutomationV1.StopPriceWatchRequest, metadata?: Metadata) {
    const correlation = this.authorize('StopPriceWatch', metadata);
    return this.execute(async () => ({
      watch: watch(await this.service.changeStatus('STOP', request, correlation)),
    }));
  }

  listPriceObservations(request: AutomationV1.ListPriceObservationsRequest, metadata?: Metadata) {
    const correlation = this.authorize('ListPriceObservations', metadata);
    return this.execute(async () => {
      const result = await this.service.observations(request, correlation);
      return { items: result.items.map(observation), next_cursor: result.next_cursor ?? undefined };
    });
  }
}
