import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CommonV1, TripV1 } from '@wolfari/contracts/grpc';
import { TripService, type TripLifecycle, type TripView } from './trip.service';
import {
  authorizeGatewayCall,
  executeTripCall,
  timestamp,
  protobufTimestamp,
  patchValue,
} from './grpc-common';

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

@Controller()
@TripV1.TripServiceControllerMethods()
export class TripGrpcController implements TripV1.TripServiceController {
  constructor(
    private readonly trips: TripService,
    private readonly config: ConfigService,
  ) {}

  private authorize(method: string, metadata?: Metadata): string {
    return authorizeGatewayCall(this.config, method, metadata);
  }

  private execute<T>(work: () => Promise<T>): Promise<T> {
    return executeTripCall(work);
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

  getPlan(): TripV1.GetPlanResponse {
    return this.unimplemented();
  }

  createActivity(): TripV1.CreateActivityResponse {
    return this.unimplemented();
  }

  updateActivity(): TripV1.UpdateActivityResponse {
    return this.unimplemented();
  }

  deleteActivity(): TripV1.DeleteActivityResponse {
    return this.unimplemented();
  }

  reorderActivities(): TripV1.ReorderActivitiesResponse {
    return this.unimplemented();
  }

  setActivityCompletion(): TripV1.SetActivityCompletionResponse {
    return this.unimplemented();
  }

  private unimplemented(): never {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'RPC is not implemented' });
  }

  getAccessContext(): TripV1.GetAccessContextResponse {
    return this.unimplemented();
  }

  beginFinanceOperation(): TripV1.BeginFinanceOperationResponse {
    return this.unimplemented();
  }

  completeOperation(): TripV1.CompleteOperationResponse {
    return this.unimplemented();
  }

  getOperationResult(): TripV1.GetOperationResultResponse {
    return this.unimplemented();
  }

  getAutomationContext(): TripV1.GetAutomationContextResponse {
    return this.unimplemented();
  }

  getInvitationDelivery(): TripV1.GetInvitationDeliveryResponse {
    return this.unimplemented();
  }

  getExportWorkerContext(): TripV1.GetExportWorkerContextResponse {
    return this.unimplemented();
  }
}
