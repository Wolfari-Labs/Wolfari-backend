import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CommonV1, RPC_CATALOG, TripV1 } from '@wolfari/contracts/grpc';
import { timingSafeEqual } from 'node:crypto';
import type { PlanEditPolicy, PlanPolicyView } from './trip-access.domain';
import { TripAccessService, type AccessContextView } from './trip-access.service';
import { TripError } from './trip.errors';
import { TripInvitationsService } from './trip-invitations.service';
import { TripPlanAccessService } from './trip-plan-access.service';
import { TripService, type TripLifecycle, type TripView } from './trip.service';

const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const callerCredentials: Record<string, string> = {
  ApiGateway: 'GATEWAY_TRIP_SECRET',
  Finance: 'FINANCE_TRIP_SECRET',
  Travel: 'TRAVEL_TRIP_SECRET',
  Automation: 'AUTOMATION_TRIP_SECRET',
};
type DeadlineCall = { getDeadline(): Date | number };
function invitationDeadline(call?: DeadlineCall): number {
  const incoming = call?.getDeadline();
  return Math.min(Date.now() + 1800, incoming === undefined ? Infinity : Number(incoming) - 100);
}

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

export function tripGrpcStatus(error: TripError): status {
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return status.INVALID_ARGUMENT;
    case 'RESOURCE_NOT_FOUND':
      return status.NOT_FOUND;
    case 'PERMISSION_DENIED':
      return status.PERMISSION_DENIED;
    case 'IDEMPOTENCY_CONFLICT':
      return status.ALREADY_EXISTS;
    case 'STATE_CONFLICT':
      return status.FAILED_PRECONDITION;
    case 'VERSION_CONFLICT':
      return status.ABORTED;
  }
}

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
    private readonly access: TripAccessService,
    private readonly planAccess: TripPlanAccessService,
    private readonly config: ConfigService,
    private readonly invitations: TripInvitationsService,
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
    const expected = this.config.get<string>(callerCredentials[caller] ?? '') ?? '';
    const providedBytes = Buffer.from(secret);
    const expectedBytes = Buffer.from(expected);
    const validSecret =
      expectedBytes.length >= 32 &&
      providedBytes.length === expectedBytes.length &&
      timingSafeEqual(providedBytes, expectedBytes);
    if (!entry?.callers.includes(caller) || !validSecret || !CORRELATION_ID.test(correlationId)) {
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
        throw new RpcException({
          code: tripGrpcStatus(error),
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

  getOperationResult(): TripV1.GetOperationResultResponse {
    return this.unimplemented();
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
      this.invitations.delivery(request, correlation, invitationDeadline(call)),
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
      this.invitations.create(request, correlation, invitationDeadline(call)),
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
          invitationDeadline(call),
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
          invitationDeadline(call),
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
          invitationDeadline(call),
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
