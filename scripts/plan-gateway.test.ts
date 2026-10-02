import { describe, expect, it } from 'vitest';
import {
  planRequest,
  planRoute,
  projectActivity,
  projectPlan,
} from '../apps/api-gateway/src/plan-proxy';
const trip = '20000000-0000-4000-8000-00000000000b';
const activity = '30000000-0000-4000-8000-00000000000c';
describe('Planning Gateway', () => {
  it('routes order before activity ids and rejects unsupported paths and methods', () => {
    expect(planRoute('PUT', `/api/v1/trips/${trip}/activities/order`)).toEqual({
      kind: 'reorder',
      tripId: trip,
    });
    expect(
      planRoute('PATCH', `/api/v1/trips/${trip}/activities/${activity}/completion`),
    ).toMatchObject({ kind: 'completion', activityId: activity });
    expect(planRoute('GET', `/api/v1/trips/${trip}/activities/order`)).toBeNull();
    expect(planRoute('POST', `/api/v1/trips/${trip}/plan`)).toBeNull();
    expect(planRoute('GET', `/api/v1/trips/${trip}/plan/extra`)).toBeNull();
    expect(() => planRoute('GET', '/api/v1/trips/invalid/plan')).toThrow();
  });
  it('preserves PATCH absence, zero position and explicit nulls', () => {
    const route = planRoute('PATCH', `/api/v1/trips/${trip}/activities/${activity}`)!;
    const request = planRequest(
      route,
      { expected_plan_version: 4, description: null, starts_at: null, position: 0 },
      trip,
      activity,
    );
    expect(request.description).toEqual({ clear: true });
    expect(request.starts_at).toEqual({ clear: true });
    expect(request).not.toHaveProperty('ends_at');
    expect(request.position).toBe(0);
    expect(() => planRequest(route, { expected_plan_version: 4 }, trip, activity)).toThrow();
  });
  it('rejects structural fields on completion and out-of-range versions', () => {
    const route = planRoute('PATCH', `/api/v1/trips/${trip}/activities/${activity}/completion`)!;
    expect(() =>
      planRequest(
        route,
        { expected_plan_version: 4, status: 'COMPLETED', title: 'Changed' },
        trip,
        activity,
      ),
    ).toThrow();
    for (const version of [0, 2147483648, '4'])
      expect(() =>
        planRequest(route, { expected_plan_version: version, status: 'TODO' }, trip, activity),
      ).toThrow();
  });
  it('defaults omitted protobuf collections, booleans and zero position', () => {
    expect(
      projectPlan({
        trip_id: trip,
        plan_version: 1,
        export_revision: 1,
        permissions: { can_read: true },
      }),
    ).toMatchObject({
      activities: [],
      selected_locations: [],
      dress_codes: [],
      packing_items: [],
      permissions: { can_read: true, can_edit: false, can_complete: false },
    });
    expect(
      projectActivity({
        id: activity,
        trip_id: trip,
        title: 'A',
        activity_type: 'OTHER',
        status: 1,
        source: 1,
        created_by_user_id: trip,
        plan_version: 1,
      }),
    ).toMatchObject({ position: 0, description: null, starts_at: null });
  });
});
