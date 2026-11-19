import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readPlaceSelection, type PlaceSnapshot } from '@wolfari/common';
import { DatabaseProvider } from '@wolfari/database';
import { TripV1 } from '@wolfari/contracts/grpc';
import {
  digest,
  fail,
  uuid,
  positiveRevision,
  lockOperation,
  receiptById,
  verifyReceipt,
  insertReceipt,
  MAX_INT32,
} from '../trip-common';
import { ACCESS_SQL, type AccessRow, type PlanVersion } from './plan.projection';
import { isPlanEditor } from './plan.service';
import { insertPlanUpdated } from './plan.events';

export function manualLocation(request: TripV1.SaveSelectedLocationRequest) {
  const name = request.name?.trim();
  const { latitude, longitude } = request;
  if (
    !name ||
    name.length > 255 ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude!) > 90 ||
    Math.abs(longitude!) > 180 ||
    (request.address?.length ?? 0) > 1000
  )
    return fail('VALIDATION_FAILED', 400);
  return {
    name,
    address: request.address?.trim() ?? '',
    latitude: latitude!,
    longitude: longitude!,
  };
}
@Injectable()
export class LocationService {
  constructor(
    private readonly database: DatabaseProvider,
    private readonly config: ConfigService,
  ) {}
  async mutate(
    request: TripV1.SaveSelectedLocationRequest | TripV1.DeleteSelectedLocationRequest,
    deleting: boolean,
    correlationId: string,
  ): Promise<TripV1.LocationMutationResponse> {
    const input = {
      actorUserId: uuid(request.actor_user_id),
      operationId: uuid(request.operation_id),
      tripId: uuid(request.trip_id),
      expectedPlanVersion: positiveRevision(request.expected_plan_version),
      correlationId: uuid(correlationId),
    };
    const operationType = deleting ? 'DELETE_SELECTED_LOCATION' : 'SAVE_SELECTED_LOCATION';
    const requestHash = digest({ operationType, request });
    return this.database.withTransaction(async (client) => {
      await lockOperation(client, input.operationId);
      await client.query('SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
        input.tripId,
      ]);
      const access = await client.query<AccessRow>(`${ACCESS_SQL} FOR UPDATE OF m`, [
        input.tripId,
        input.actorUserId,
      ]);
      const trip = access.rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
      if (!isPlanEditor(trip.role, trip.plan_edit_policy, trip.selected_editor))
        return fail('PERMISSION_DENIED', 403);
      const receipt = await receiptById(client, input.operationId);
      if (receipt)
        return verifyReceipt(receipt, {
          ...input,
          operationType,
          requestHash,
        }) as TripV1.LocationMutationResponse;
      if (trip.archived_at !== null) return fail('STATE_CONFLICT', 409);
      if (trip.plan_version !== input.expectedPlanVersion) return fail('VERSION_CONFLICT', 409);
      let locationId: string;
      let changed = true;
      if (deleting) {
        locationId = uuid((request as TripV1.DeleteSelectedLocationRequest).location_id);
        const used = await client.query(
          'SELECT id FROM activities WHERE trip_id=$1 AND selected_location_id=$2 LIMIT 1',
          [input.tripId, locationId],
        );
        if (used.rowCount) return fail('STATE_CONFLICT', 409);
        const removed = await client.query(
          'DELETE FROM selected_locations WHERE id=$1 AND trip_id=$2 RETURNING id',
          [locationId, input.tripId],
        );
        if (!removed.rowCount) return fail('RESOURCE_NOT_FOUND', 404);
      } else {
        const save = request as TripV1.SaveSelectedLocationRequest;
        let place: ReturnType<typeof manualLocation> | PlaceSnapshot;
        let provider: string | null = null,
          providerId: string | null = null,
          fetchedAt: string | null = null;
        let metadata: Record<string, unknown> = {};
        if (save.selection_token) {
          if ([save.name, save.address, save.latitude, save.longitude].some((v) => v !== undefined))
            return fail('VALIDATION_FAILED', 400);
          try {
            const selection = readPlaceSelection(
              save.selection_token,
              this.config.get<string>('PLACE_SELECTION_SECRET') ?? '',
              input.actorUserId,
              input.tripId,
            );
            if (selection.expires <= Date.now()) return fail('VALIDATION_FAILED', 400);
            place = selection.place;
            manualLocation({
              ...save,
              name: place.name,
              address: place.address,
              latitude: place.latitude,
              longitude: place.longitude,
            });
            provider = selection.place.provider;
            providerId = selection.place.provider_place_id;
            fetchedAt = selection.place.fetched_at;
            if (
              !providerId ||
              providerId.length > 2048 ||
              !fetchedAt ||
              !Number.isFinite(Date.parse(fetchedAt))
            )
              return fail('VALIDATION_FAILED', 400);
            metadata = {
              categories: selection.place.categories,
              attribution: selection.place.attribution,
            };
          } catch {
            return fail('VALIDATION_FAILED', 400);
          }
        } else place = manualLocation(save);
        const existing = provider
          ? await client.query<{ id: string }>(
              'SELECT id FROM selected_locations WHERE trip_id=$1 AND provider=$2 AND provider_place_id=$3',
              [input.tripId, provider, providerId],
            )
          : null;
        if (existing?.rows[0]) {
          locationId = existing.rows[0].id;
          changed = false;
        } else {
          const created = await client.query<{ id: string }>(
            `INSERT INTO selected_locations(trip_id,provider,provider_place_id,name,address,latitude,longitude,source,fetched_at,metadata,created_by_user_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
            [
              input.tripId,
              provider,
              providerId,
              place.name,
              place.address,
              place.latitude,
              place.longitude,
              provider ? 'PROVIDER' : 'MANUAL',
              fetchedAt,
              JSON.stringify(metadata),
              input.actorUserId,
            ],
          );
          locationId = created.rows[0]!.id;
        }
      }
      let version: PlanVersion = {
        trip_id: input.tripId,
        plan_version: trip.plan_version,
        export_revision: trip.export_revision,
      };
      if (changed) {
        if (trip.plan_version >= MAX_INT32 || trip.export_revision >= MAX_INT32)
          return fail('STATE_CONFLICT', 409);
        version = (
          await client.query<PlanVersion>(
            'UPDATE trips SET plan_version=plan_version+1,export_revision=export_revision+1,updated_at=now() WHERE id=$1 RETURNING id AS trip_id,plan_version,export_revision',
            [input.tripId],
          )
        ).rows[0]!;
        await client.query(
          `INSERT INTO trip_audit_logs(trip_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,details,correlation_id)
          VALUES($1,$2,$3,'SELECTED_LOCATION',$4,$5,$6,'{}'::jsonb,$7)`,
          [
            input.tripId,
            input.actorUserId,
            operationType,
            locationId,
            trip.plan_version,
            version.plan_version,
            input.correlationId,
          ],
        );
        await insertPlanUpdated(client, {
          ...input,
          planVersion: version.plan_version,
          changes: [
            { type: 'SELECTED_LOCATION', id: locationId, action: deleting ? 'DELETE' : 'UPSERT' },
          ],
        });
      }
      const outcome = { location_id: locationId, version };
      await insertReceipt(client, {
        ...input,
        operationType,
        requestHash,
        contextRevision: version.plan_version,
        outcome,
        commandPayload: {
          expected_plan_version: input.expectedPlanVersion,
          location_id: locationId,
        },
      });
      return outcome;
    });
  }
}
