import { PlanGrpcHandlers } from './planning/plan.grpc';
import { LifecycleService } from './operations/lifecycle.service';
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CommonV1, TripV1 } from '@wolfari/contracts/grpc';
import { TripService, type TripLifecycle, type TripView } from './trip.service';
import {
  authorizeTripCall,
  executeTripCall,
  timestamp,
  protobufTimestamp,
  patchValue,
  tripRequestDeadline,
  type DeadlineCall,
} from './grpc-common';
import type { PlanEditPolicy, PlanPolicyView } from './trip-access.domain';
import { TripAccessService, type AccessContextView } from './trip-access.service';
import { TripInvitationsService } from './trip-invitations.service';
import { TripPlanAccessService } from './trip-plan-access.service';
export { tripGrpcStatus } from './grpc-common';

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

const planPolicy: Record<PlanEditPolicy, CommonV1.PlanPolicy> = {
  OWNER_ONLY: CommonV1.PlanPolicy.PLAN_POLICY_OWNER_ONLY,
  SELECTED_MEMBERS: CommonV1.PlanPolicy.PLAN_POLICY_SELECTED_MEMBERS,
  ALL_MEMBERS: CommonV1.PlanPolicy.PLAN_POLICY_ALL_MEMBERS,
};

const protoToPlanPolicy: Partial<Record<CommonV1.PlanPolicy, PlanEditPolicy>> = {
  [CommonV1.PlanPolicy.PLAN_POLICY_OWNER_ONLY]: 'OWNER_ONLY',
  [CommonV1.PlanPolicy.PLAN_POLICY_SELECTED_MEMBERS]: 'SELECTED_MEMBERS',
  [CommonV1.PlanPolicy.PLAN_POLICY_ALL_MEMBERS]: 'ALL_MEMBERS',
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

function protobufPlanPolicy(value: PlanPolicyView): TripV1.PlanPolicySettings {
  return {
    policy: planPolicy[value.policy],
    editor_member_ids: value.editor_member_ids,
    membership_revision: value.membership_revision,
  };
}

function protobufAccessContext(value: AccessContextView): CommonV1.AccessContext {
  return {
    trip_id: value.trip_id,
    membership: {
      id: value.membership.id,
      trip_id: value.membership.trip_id,
      user_id: value.membership.user_id,
      role:
        value.membership.role === 'OWNER'
          ? CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER
          : CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
      joined_at: protobufTimestamp(value.membership.joined_at),
      left_at:
        value.membership.left_at === null ? undefined : protobufTimestamp(value.membership.left_at),
    },
    policy: planPolicy[value.policy],
    trip_state:
      value.trip_state === 'ACTIVE'
        ? CommonV1.TripState.TRIP_STATE_ACTIVE
        : CommonV1.TripState.TRIP_STATE_ARCHIVED,
    revisions: value.revisions,
    allowed: value.allowed,
    permissions: value.permissions,
    can_read_trip: value.can_read_trip,
    can_update_trip_metadata: value.can_update_trip_metadata,
    can_edit_plan: value.can_edit_plan,
  };
}

@Controller()
@TripV1.TripServiceControllerMethods()
export class TripGrpcController implements TripV1.TripServiceController {
  constructor(
    private readonly trips: TripService,
    private readonly plans: PlanGrpcHandlers,
    private readonly access: TripAccessService,
    private readonly planAccess: TripPlanAccessService,
    private readonly config: ConfigService,
    private readonly invitations: TripInvitationsService,
    private readonly lifecycle: LifecycleService,
  ) {}

  private authorize(method: string, metadata?: Metadata): string {
    return authorizeTripCall(this.config, method, metadata);
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

  getPlan(request: TripV1.GetPlanRequest, metadata?: Metadata) {
    return this.plans.getPlan(request, metadata);
  }

  createActivity(request: TripV1.CreateActivityRequest, metadata?: Metadata) {
    return this.plans.createActivity(request, metadata);
  }

  updateActivity(request: TripV1.UpdateActivityRequest, metadata?: Metadata) {
    return this.plans.updateActivity(request, metadata);
  }

  deleteActivity(request: TripV1.DeleteActivityRequest, metadata?: Metadata) {
    return this.plans.deleteActivity(request, metadata);
  }

  reorderActivities(request: TripV1.ReorderActivitiesRequest, metadata?: Metadata) {
    return this.plans.reorderActivities(request, metadata);
  }

  setActivityCompletion(request: TripV1.SetActivityCompletionRequest, metadata?: Metadata) {
    return this.plans.setActivityCompletion(request, metadata);
  }

  private unimplemented(): never {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'RPC is not implemented' });
  }

  getAccessContext(
    request: TripV1.GetAccessContextRequest,
    metadata?: Metadata,
  ): Promise<TripV1.GetAccessContextResponse> {
    this.authorize('GetAccessContext', metadata);
    return this.execute(async () => ({
      context: protobufAccessContext(
        await this.access.getContext({
          tripId: request.trip_id,
          userId: request.user_id,
          action: request.action,
        }),
      ),
    }));
  }

  updatePlanPolicy(
    request: TripV1.UpdatePlanPolicyRequest,
    metadata?: Metadata,
  ): Promise<TripV1.UpdatePlanPolicyResponse> {
    const correlationId = this.authorize('UpdatePlanPolicy', metadata);
    return this.execute(async () => ({
      plan_policy: protobufPlanPolicy(
        await this.planAccess.updatePolicy({
          operationId: request.operation_id,
          actorUserId: request.actor_user_id,
          tripId: request.trip_id,
          policy: protoToPlanPolicy[request.policy!],
          editorMemberIds: request.editor_member_ids ?? [],
          expectedMembershipRevision: request.expected_membership_revision,
          correlationId,
        }),
      ),
    }));
  }

  beginFinanceOperation(): TripV1.BeginFinanceOperationResponse {
    return this.unimplemented();
  }

  completeOperation(): TripV1.CompleteOperationResponse {
    return this.unimplemented();
  }

  getOperationResult(
    request: TripV1.GetOperationResultRequest,
    metadata?: Metadata,
  ): Promise<TripV1.GetOperationResultResponse> {
    this.authorize('GetOperationResult', metadata);
    return this.execute(async () => ({
      operation: await this.lifecycle.getOperation(request.operation_id, request.actor_user_id),
    }));
  }

  listMembers(
    request: TripV1.ListMembersRequest,
    metadata?: Metadata,
  ): Promise<TripV1.ListMembersResponse> {
    this.authorize('ListMembers', metadata);
    return this.execute(() => this.lifecycle.list(request));
  }

  leaveTrip(
    request: TripV1.LeaveTripRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.LeaveTripResponse> {
    const correlation = this.authorize('LeaveTrip', metadata);
    return this.execute(async () => ({
      operation: await this.lifecycle.execute(
        { ...request },
        'LEAVE_MEMBER',
        correlation,
        tripRequestDeadline(call),
      ),
    }));
  }

  removeMember(
    request: TripV1.RemoveMemberRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.RemoveMemberResponse> {
    const correlation = this.authorize('RemoveMember', metadata);
    return this.execute(async () => ({
      operation: await this.lifecycle.execute(
        { ...request },
        'REMOVE_MEMBER',
        correlation,
        tripRequestDeadline(call),
      ),
    }));
  }

  getAutomationContext(): TripV1.GetAutomationContextResponse {
    return this.unimplemented();
  }

  getInvitationDelivery(
    request: TripV1.GetInvitationDeliveryRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.GetInvitationDeliveryResponse> {
    const correlation = this.authorize('GetInvitationDelivery', metadata);
    return this.execute(() =>
      this.invitations.delivery(request, correlation, tripRequestDeadline(call)),
    );
  }
  acknowledgeInvitationDelivery(
    request: TripV1.AcknowledgeInvitationDeliveryRequest,
    metadata?: Metadata,
  ): Promise<TripV1.AcknowledgeInvitationDeliveryResponse> {
    this.authorize('AcknowledgeInvitationDelivery', metadata);
    return this.execute(() => this.invitations.acknowledge(request));
  }
  createInvitation(
    request: TripV1.CreateInvitationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.CreateInvitationResponse> {
    const correlation = this.authorize('CreateInvitation', metadata);
    return this.execute(() =>
      this.invitations.create(request, correlation, tripRequestDeadline(call)),
    );
  }
  listInvitations(
    request: TripV1.ListInvitationsRequest,
    metadata?: Metadata,
  ): Promise<TripV1.ListInvitationsResponse> {
    const correlation = this.authorize('ListInvitations', metadata);
    return this.execute(() => this.invitations.list(request, correlation));
  }
  previewInvitation(
    request: TripV1.PreviewInvitationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.PreviewInvitationResponse> {
    const correlation = this.authorize('PreviewInvitation', metadata);
    return this.execute(
      async () =>
        (await this.invitations.tokenCommand(
          request,
          correlation,
          'PREVIEW_INVITATION',
          tripRequestDeadline(call),
        )) as TripV1.PreviewInvitationResponse,
    );
  }
  acceptInvitation(
    request: TripV1.AcceptInvitationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.AcceptInvitationResponse> {
    const correlation = this.authorize('AcceptInvitation', metadata);
    return this.execute(
      async () =>
        (await this.invitations.tokenCommand(
          request,
          correlation,
          'ACCEPT_INVITATION',
          tripRequestDeadline(call),
        )) as TripV1.AcceptInvitationResponse,
    );
  }
  declineInvitation(
    request: TripV1.DeclineInvitationRequest,
    metadata?: Metadata,
    call?: DeadlineCall,
  ): Promise<TripV1.DeclineInvitationResponse> {
    const correlation = this.authorize('DeclineInvitation', metadata);
    return this.execute(
      async () =>
        (await this.invitations.tokenCommand(
          request,
          correlation,
          'DECLINE_INVITATION',
          tripRequestDeadline(call),
        )) as TripV1.DeclineInvitationResponse,
    );
  }
  revokeInvitation(
    request: TripV1.RevokeInvitationRequest,
    metadata?: Metadata,
  ): Promise<TripV1.RevokeInvitationResponse> {
    const correlation = this.authorize('RevokeInvitation', metadata);
    return this.execute(() =>
      this.invitations.versionCommand(request, correlation, 'REVOKE_INVITATION'),
    );
  }
  resendInvitation(
    request: TripV1.ResendInvitationRequest,
    metadata?: Metadata,
  ): Promise<TripV1.ResendInvitationResponse> {
    const correlation = this.authorize('ResendInvitation', metadata);
    return this.execute(() =>
      this.invitations.versionCommand(request, correlation, 'RESEND_INVITATION'),
    );
  }

  getExportWorkerContext(): TripV1.GetExportWorkerContextResponse {
    return this.unimplemented();
  }
}
