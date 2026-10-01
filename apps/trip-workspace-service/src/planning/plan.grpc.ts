import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Metadata } from '@grpc/grpc-js';
import { TripV1 } from '@wolfari/contracts/grpc';
import {
  authorizeTripCall,
  executeTripCall,
  patchValue,
  protobufTimestamp,
  timestamp,
} from '../grpc-common';
import { fail } from '../trip-common';
import { PlanService, type MutationResult } from './plan.service';
import type { ActivityView, PlanView } from './plan.projection';

const source = {
  MANUAL: TripV1.EntitySource.ENTITY_SOURCE_MANUAL,
  PROVIDER: TripV1.EntitySource.ENTITY_SOURCE_PROVIDER,
  DSS: TripV1.EntitySource.ENTITY_SOURCE_DSS,
};
const status = {
  TODO: TripV1.ActivityStatus.ACTIVITY_STATUS_TODO,
  COMPLETED: TripV1.ActivityStatus.ACTIVITY_STATUS_COMPLETED,
};
const scope = {
  TRIP: TripV1.DressScope.DRESS_SCOPE_TRIP,
  DAY: TripV1.DressScope.DRESS_SCOPE_DAY,
  ACTIVITY: TripV1.DressScope.DRESS_SCOPE_ACTIVITY,
};
const optionalTime = (value: string | null) =>
  value === null ? undefined : protobufTimestamp(value);
type WireTime = { seconds?: string; nanos?: number };
function readTime(value: WireTime): Date {
  return timestamp({ seconds: value.seconds ?? '0', nanos: value.nanos ?? 0 });
}
export function timestampPatch(value: TripV1.TimestampPatch): Date | null {
  const hasValue = value.value !== undefined,
    hasClear = value.clear !== undefined;
  if (hasValue === hasClear || (hasClear && value.clear !== true))
    return fail('VALIDATION_FAILED', 400);
  return hasValue ? readTime(value.value!) : null;
}
function activity(value: ActivityView): TripV1.PlanActivity {
  return {
    ...value,
    description: value.description ?? undefined,
    public_description: value.public_description ?? undefined,
    selected_location_id: value.selected_location_id ?? undefined,
    starts_at: optionalTime(value.starts_at),
    ends_at: optionalTime(value.ends_at),
    completed_at: optionalTime(value.completed_at),
    completed_by_user_id: value.completed_by_user_id ?? undefined,
    status: status[value.status],
    source: source[value.source],
  };
}
function plan(value: PlanView): TripV1.Plan {
  return {
    ...value,
    activities: value.activities.map(activity),
    selected_locations: value.selected_locations.map(({ metadata, opening_hours, ...row }) => ({
      ...row,
      address: row.address ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      provider: row.provider ?? undefined,
      provider_place_id: row.provider_place_id ?? undefined,
      fetched_at: optionalTime(row.fetched_at),
      source: source[row.source],
      metadata_json: JSON.stringify(metadata),
      opening_hours_json: opening_hours === null ? undefined : JSON.stringify(opening_hours),
    })),
    dress_codes: value.dress_codes.map((row) => ({
      ...row,
      scope_type: scope[row.scope_type],
      plan_date: row.plan_date ?? undefined,
      activity_id: row.activity_id ?? undefined,
      description: row.description ?? undefined,
      public_description: row.public_description ?? undefined,
      source: source[row.source],
    })),
    packing_items: value.packing_items.map((row) => ({
      ...row,
      unit: row.unit ?? undefined,
      note: row.note ?? undefined,
      category: row.category ?? undefined,
      assigned_member_id: row.assigned_member_id ?? undefined,
      due_at: optionalTime(row.due_at),
      completed_at: optionalTime(row.completed_at),
      completed_by_user_id: row.completed_by_user_id ?? undefined,
      status: status[row.status],
      source: source[row.source],
    })),
  };
}
function activityResult(result: MutationResult): TripV1.CreateActivityResponse {
  if (!result.activity) throw new Error('Missing activity outcome');
  return { activity: activity(result.activity), export_revision: result.version.export_revision };
}
function base(
  request: Pick<
    TripV1.CreateActivityRequest,
    'operation_id' | 'actor_user_id' | 'trip_id' | 'expected_plan_version'
  >,
  correlationId: string,
) {
  return {
    operationId: request.operation_id,
    actorUserId: request.actor_user_id,
    tripId: request.trip_id,
    expectedPlanVersion: request.expected_plan_version,
    correlationId,
  };
}
@Injectable()
export class PlanGrpcHandlers {
  constructor(
    private readonly plans: PlanService,
    private readonly config: ConfigService,
  ) {}
  private call<T>(
    method: string,
    metadata: Metadata | undefined,
    work: (id: string) => Promise<T>,
  ): Promise<T> {
    const id = authorizeTripCall(this.config, method, metadata);
    return executeTripCall(() => work(id));
  }
  getPlan(request: TripV1.GetPlanRequest, metadata?: Metadata): Promise<TripV1.GetPlanResponse> {
    return this.call('GetPlan', metadata, async () => ({
      plan: plan(await this.plans.getPlan(request.actor_user_id, request.trip_id)),
    }));
  }
  createActivity(
    request: TripV1.CreateActivityRequest,
    metadata?: Metadata,
  ): Promise<TripV1.CreateActivityResponse> {
    return this.call('CreateActivity', metadata, async (id) => {
      const fields: Record<string, unknown> = {
        title: request.title,
        activity_type: request.activity_type,
        position: request.position ?? 0,
      };
      for (const key of ['description', 'public_description', 'selected_location_id'] as const)
        if (request[key] !== undefined) fields[key] = request[key];
      for (const key of ['starts_at', 'ends_at'] as const)
        if (request[key] !== undefined) fields[key] = readTime(request[key]!);
      return activityResult(await this.plans.createActivity({ ...base(request, id), fields }));
    });
  }
  updateActivity(
    request: TripV1.UpdateActivityRequest,
    metadata?: Metadata,
  ): Promise<TripV1.UpdateActivityResponse> {
    return this.call('UpdateActivity', metadata, async (id) => {
      const fields: Record<string, unknown> = {};
      for (const key of ['title', 'activity_type', 'position'] as const)
        if (request[key] !== undefined) fields[key] = request[key];
      for (const key of ['description', 'public_description', 'selected_location_id'] as const)
        if (request[key] !== undefined) fields[key] = patchValue(request[key]!);
      for (const key of ['starts_at', 'ends_at'] as const)
        if (request[key] !== undefined) fields[key] = timestampPatch(request[key]!);
      return activityResult(
        await this.plans.updateActivity({
          ...base(request, id),
          activityId: request.activity_id,
          fields,
        }),
      );
    });
  }
  deleteActivity(
    request: TripV1.DeleteActivityRequest,
    metadata?: Metadata,
  ): Promise<TripV1.DeleteActivityResponse> {
    return this.call('DeleteActivity', metadata, async (id) => ({
      version: (
        await this.plans.deleteActivity({
          ...base(request, id),
          activityId: request.activity_id,
          confirmed: request.confirmed,
        })
      ).version,
    }));
  }
  reorderActivities(
    request: TripV1.ReorderActivitiesRequest,
    metadata?: Metadata,
  ): Promise<TripV1.ReorderActivitiesResponse> {
    return this.call('ReorderActivities', metadata, async (id) => ({
      version: (
        await this.plans.reorderActivities({
          ...base(request, id),
          activityIds: request.activity_ids ?? [],
        })
      ).version,
    }));
  }
  setActivityCompletion(
    request: TripV1.SetActivityCompletionRequest,
    metadata?: Metadata,
  ): Promise<TripV1.SetActivityCompletionResponse> {
    return this.call('SetActivityCompletion', metadata, async (id) =>
      activityResult(
        await this.plans.setActivityCompletion({
          ...base(request, id),
          activityId: request.activity_id,
          status:
            request.status === status.TODO
              ? 'TODO'
              : request.status === status.COMPLETED
                ? 'COMPLETED'
                : undefined,
        }),
      ),
    );
  }
}
