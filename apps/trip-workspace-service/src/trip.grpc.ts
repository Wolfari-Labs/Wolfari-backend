import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CommonV1, RPC_CATALOG, TripV1 } from '@wolfari/contracts/grpc';
import { timingSafeEqual } from 'node:crypto';
import { TripError, TripService, type TripLifecycle, type TripView } from './trip.service';

const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timestamp(value: { seconds?: string; nanos?: number } | undefined): Date {
  if (
    !value ||
    typeof value.seconds !== 'string' ||
    !/^-?\d+$/.test(value.seconds) ||
    !Number.isInteger(value.nanos) ||
    Number(value.nanos) < 0 ||
    Number(value.nanos) > 999_999_999
  ) {
    throw new TripError('VALIDATION_FAILED', 400);
  }
  const seconds = Number(value.seconds);
  const milliseconds = seconds * 1000 + Math.floor(Number(value.nanos) / 1_000_000);
  const result = new Date(milliseconds);
  if (!Number.isSafeInteger(seconds) || Number.isNaN(result.getTime())) {
    throw new TripError('VALIDATION_FAILED', 400);
  }
  return result;
}

function protobufTimestamp(value: string): { seconds: string; nanos: number } {
  const milliseconds = new Date(value).getTime();
  return {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: (((milliseconds % 1000) + 1000) % 1000) * 1_000_000,
  };
}

const lifecycleToProto: Record<TripLifecycle, TripV1.TripLifecycle> = {
  UPCOMING: TripV1.TripLifecycle.TRIP_LIFECYCLE_UPCOMING,
  ONGOING: TripV1.TripLifecycle.TRIP_LIFECYCLE_ONGOING,
  COMPLETED: TripV1.TripLifecycle.TRIP_LIFECYCLE_COMPLETED,
  ARCHIVED: TripV1.TripLifecycle.TRIP_LIFECYCLE_ARCHIVED,
};

const protoToLifecycle: Partial<Record<TripV1.TripLifecycle, TripLifecycle>> = {
  [TripV1.TripLifecycle.TRIP_LIFECYCLE_UPCOMING]: 'UPCOMING',
  [TripV1.TripLifecycle.TRIP_LIFECYCLE_ONGOING]: 'ONGOING',
  [TripV1.TripLifecycle.TRIP_LIFECYCLE_COMPLETED]: 'COMPLETED',
  [TripV1.TripLifecycle.TRIP_LIFECYCLE_ARCHIVED]: 'ARCHIVED',
};

const planPolicy: Record<TripView['plan_edit_policy'], CommonV1.PlanPolicy> = {
  OWNER_ONLY: CommonV1.PlanPolicy.PLAN_POLICY_OWNER_ONLY,
  SELECTED_MEMBERS: CommonV1.PlanPolicy.PLAN_POLICY_SELECTED_MEMBERS,
  ALL_MEMBERS: CommonV1.PlanPolicy.PLAN_POLICY_ALL_MEMBERS,
};

function protobufTrip(value: TripView): TripV1.Trip {
  return {
    id: value.id,
    name: value.name,
    description: value.description ?? undefined,
    start_at: protobufTimestamp(value.start_at),
    end_at: protobufTimestamp(value.end_at),
    timezone: value.timezone,
    lifecycle: lifecycleToProto[value.lifecycle],
    archived_at: value.archived_at === null ? undefined : protobufTimestamp(value.archived_at),
    public_description: value.public_description ?? undefined,
    plan_edit_policy: planPolicy[value.plan_edit_policy],
    plan_version: value.plan_version,
    membership_revision: value.membership_revision,
    export_revision: value.export_revision,
    current_membership: {
      id: value.current_membership.id,
      trip_id: value.current_membership.trip_id,
      user_id: value.current_membership.user_id,
      role:
        value.current_membership.role === 'OWNER'
          ? CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER
          : CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
      joined_at: protobufTimestamp(value.current_membership.joined_at),
      left_at:
        value.current_membership.left_at === null
          ? undefined
          : protobufTimestamp(value.current_membership.left_at),
    },
    permissions: {
      can_read: value.permissions.includes('TRIP_VIEW'),
      can_update: value.permissions.includes('TRIP_UPDATE_METADATA'),
    },
  };
}

function patchValue(value: TripV1.StringPatch): string | null {
  const hasValue = value.value !== undefined;
  const hasClear = value.clear !== undefined;
  if (hasValue === hasClear || (hasClear && value.clear !== true)) {
    throw new TripError('VALIDATION_FAILED', 400);
  }
  return hasValue ? value.value! : null;
}

@Controller()
@TripV1.TripServiceControllerMethods()
export class TripGrpcController implements TripV1.TripServiceController {
  constructor(
    private readonly trips: TripService,
    private readonly config: ConfigService,
  ) {}

  private authorize(method: string, metadata?: Metadata): string {
    const caller = String(metadata?.get('x-caller-service')[0] ?? '');
    const secret = String(metadata?.get('x-service-secret')[0] ?? '');
    const correlationId = String(metadata?.get('x-correlation-id')[0] ?? '');
    const entry = RPC_CATALOG.find(
      (value) =>
        value.package === 'wolfari.trip.v1' &&
        value.service === 'TripService' &&
        value.method === method,
    );
    const expected = this.config.get<string>('GATEWAY_TRIP_SECRET') ?? '';
    const providedBytes = Buffer.from(secret);
    const expectedBytes = Buffer.from(expected);
    const validSecret =
      expectedBytes.length >= 32 &&
      providedBytes.length === expectedBytes.length &&
      timingSafeEqual(providedBytes, expectedBytes);
    if (
      caller !== 'ApiGateway' ||
      !entry?.callers.includes(caller) ||
      !validSecret ||
      !CORRELATION_ID.test(correlationId)
    ) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Caller is not authorized',
      });
    }
    return correlationId.toLowerCase();
  }

  private async execute<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TripError) {
        const code =
          error.code === 'VALIDATION_FAILED'
            ? status.INVALID_ARGUMENT
            : error.code === 'RESOURCE_NOT_FOUND'
              ? status.NOT_FOUND
              : error.code === 'PERMISSION_DENIED'
                ? status.PERMISSION_DENIED
                : error.code === 'IDEMPOTENCY_CONFLICT'
                  ? status.ALREADY_EXISTS
                  : error.code === 'STATE_CONFLICT'
                    ? status.FAILED_PRECONDITION
                    : status.ABORTED;
        throw new RpcException({
          code,
          message: JSON.stringify({ code: error.code, details: error.details }),
        });
      }
      throw new RpcException({
        code: status.UNAVAILABLE,
        message: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', details: null }),
      });
    }
  }

  createTrip(
    request: TripV1.CreateTripRequest,
    metadata?: Metadata,
  ): Promise<TripV1.CreateTripResponse> {
    const correlationId = this.authorize('CreateTrip', metadata);
    return this.execute(async () => ({
      trip: protobufTrip(
        await this.trips.create({
          actorUserId: request.actor_user_id,
          operationId: request.operation_id,
          name: request.name,
          description: request.description,
          startAt: timestamp(request.start_at),
          endAt: timestamp(request.end_at),
          timezone: request.timezone,
          correlationId,
        }),
      ),
    }));
  }

  listTrips(
    request: TripV1.ListTripsRequest,
    metadata?: Metadata,
  ): Promise<TripV1.ListTripsResponse> {
    this.authorize('ListTrips', metadata);
    return this.execute(async () => {
      const lifecycle =
        request.lifecycle === undefined
          ? undefined
          : (protoToLifecycle[request.lifecycle] ?? request.lifecycle);
      const result = await this.trips.list({
        actorUserId: request.actor_user_id,
        limit: request.limit,
        cursor: request.cursor,
        lifecycle,
      });
      return {
        items: result.items.map(protobufTrip),
        next_cursor: result.next_cursor ?? undefined,
      };
    });
  }

  getTrip(request: TripV1.GetTripRequest, metadata?: Metadata): Promise<TripV1.GetTripResponse> {
    this.authorize('GetTrip', metadata);
    return this.execute(async () => ({
      trip: protobufTrip(await this.trips.get(request.actor_user_id, request.trip_id)),
    }));
  }

  updateTrip(
    request: TripV1.UpdateTripRequest,
    metadata?: Metadata,
  ): Promise<TripV1.UpdateTripResponse> {
    const correlationId = this.authorize('UpdateTrip', metadata);
    return this.execute(async () => {
      const fields: Record<string, unknown> = {};
      if (request.name !== undefined) fields.name = request.name;
      if (request.description !== undefined) fields.description = patchValue(request.description);
      if (request.public_description !== undefined) {
        fields.public_description = patchValue(request.public_description);
      }
      return {
        trip: protobufTrip(
          await this.trips.update({
            actorUserId: request.actor_user_id,
            operationId: request.operation_id,
            tripId: request.trip_id,
            expectedPlanVersion: request.expected_plan_version,
            expectedExportRevision: request.expected_export_revision,
            fields,
            correlationId,
          }),
        ),
      };
    });
  }

  private unimplemented(): never {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'RPC is not implemented' });
  }

  getAccessContext(
    _request: TripV1.GetAccessContextRequest,
    _metadata?: Metadata,
  ): TripV1.GetAccessContextResponse {
    return this.unimplemented();
  }

  beginFinanceOperation(
    _request: TripV1.BeginFinanceOperationRequest,
    _metadata?: Metadata,
  ): TripV1.BeginFinanceOperationResponse {
    return this.unimplemented();
  }

  completeOperation(
    _request: TripV1.CompleteOperationRequest,
    _metadata?: Metadata,
  ): TripV1.CompleteOperationResponse {
    return this.unimplemented();
  }

  getOperationResult(
    _request: TripV1.GetOperationResultRequest,
    _metadata?: Metadata,
  ): TripV1.GetOperationResultResponse {
    return this.unimplemented();
  }

  getAutomationContext(
    _request: TripV1.GetAutomationContextRequest,
    _metadata?: Metadata,
  ): TripV1.GetAutomationContextResponse {
    return this.unimplemented();
  }

  getInvitationDelivery(
    _request: TripV1.GetInvitationDeliveryRequest,
    _metadata?: Metadata,
  ): TripV1.GetInvitationDeliveryResponse {
    return this.unimplemented();
  }

  getExportWorkerContext(
    _request: TripV1.GetExportWorkerContextRequest,
    _metadata?: Metadata,
  ): TripV1.GetExportWorkerContextResponse {
    return this.unimplemented();
  }
}
