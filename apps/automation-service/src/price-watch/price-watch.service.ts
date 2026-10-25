import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationV1 } from '@wolfari/contracts/grpc';
import { PriceWatchAccessService, type PriceTripContext } from './price-watch-access.service';
import { PriceWatchCursor } from './price-watch.cursor';
import {
  expectedVersion,
  mergeWatchPatch,
  normalizeWatch,
  pageLimit,
  transition,
  watchUuid,
  type NormalizedWatchWrite,
} from './price-watch.domain';
import { priceWatchFail } from './price-watch.errors';
import {
  PriceWatchRepository,
  type ObservationRecord,
  type PriceWatchRecord,
} from './price-watch.repository';

@Injectable()
export class PriceWatchService {
  private readonly cursor: PriceWatchCursor;

  constructor(
    config: ConfigService,
    private readonly access: PriceWatchAccessService,
    private readonly repository: PriceWatchRepository,
  ) {
    this.cursor = new PriceWatchCursor(config.get<string>('AUTOMATION_CURSOR_SECRET') ?? '');
  }

  async create(
    request: AutomationV1.CreatePriceWatchRequest,
    correlationId: string,
  ): Promise<PriceWatchRecord> {
    const userId = watchUuid(request.actor_user_id);
    const tripId = watchUuid(request.trip_id);
    const clientRequestId = watchUuid(request.client_request_id);
    if (!request.watch) return priceWatchFail('VALIDATION_FAILED');
    const context = await this.writeContext(tripId, userId, correlationId);
    const value = normalizeWatch(request.watch, {
      tripId,
      userId,
      membershipId: context.membershipId,
    });
    return this.repository.create({
      userId,
      tripId,
      membershipId: context.membershipId,
      clientRequestId,
      value,
    });
  }

  async list(request: AutomationV1.ListPriceWatchesRequest, correlationId: string) {
    const userId = watchUuid(request.actor_user_id);
    const tripId = watchUuid(request.trip_id);
    await this.access.get(tripId, userId, correlationId);
    const limit = pageLimit(request.limit);
    const after = request.cursor
      ? this.cursor.decode(request.cursor, 'WATCHES', tripId)
      : undefined;
    const rows = await this.repository.list(tripId, limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > limit && last
          ? this.cursor.encode({
              scope: 'WATCHES',
              parent_id: tripId,
              sort_at: last.created_at,
              id: last.id,
            })
          : null,
    };
  }

  async update(request: AutomationV1.UpdatePriceWatchRequest, correlationId: string) {
    const userId = watchUuid(request.actor_user_id);
    const id = watchUuid(request.watch_id);
    const version = expectedVersion(request.expected_version);
    if (!request.patch) return priceWatchFail('VALIDATION_FAILED');
    const current = await this.requiredWatch(id);
    const context = await this.writeContext(current.trip_id, userId, correlationId);
    this.creator(current, userId, context);
    const next = mergeWatchPatch(this.normalized(current), request.patch, {
      tripId: current.trip_id,
      userId,
      membershipId: context.membershipId,
    });
    return this.repository.update(id, version, next, (locked) =>
      this.creator(locked, userId, context),
    );
  }

  async changeStatus(
    command: 'PAUSE' | 'RESUME' | 'STOP',
    request:
      | AutomationV1.PausePriceWatchRequest
      | AutomationV1.ResumePriceWatchRequest
      | AutomationV1.StopPriceWatchRequest,
    correlationId: string,
  ) {
    const userId = watchUuid(request.actor_user_id);
    const id = watchUuid(request.watch_id);
    const version = expectedVersion(request.expected_version);
    const current = await this.requiredWatch(id);
    const context = await this.writeContext(current.trip_id, userId, correlationId);
    const authorize = (locked: PriceWatchRecord) => {
      if (command === 'STOP' && context.role === 'OWNER') return;
      this.creator(locked, userId, context);
    };
    authorize(current);
    if (command === 'RESUME' && new Date(current.expires_at).getTime() <= Date.now())
      return priceWatchFail('STATE_CONFLICT');
    const next = transition(current.status, command);
    return this.repository.changeStatus(
      id,
      version,
      next,
      command === 'STOP' ? 'USER_STOPPED' : null,
      authorize,
    );
  }

  async observations(
    request: AutomationV1.ListPriceObservationsRequest,
    correlationId: string,
  ): Promise<{ items: ObservationRecord[]; next_cursor: string | null }> {
    const userId = watchUuid(request.actor_user_id);
    const id = watchUuid(request.watch_id);
    const watch = await this.requiredWatch(id);
    await this.access.get(watch.trip_id, userId, correlationId);
    const limit = pageLimit(request.limit);
    const cursorScope = `${id}:${watch.query_group_id}`;
    const after = request.cursor
      ? this.cursor.decode(request.cursor, 'OBSERVATIONS', cursorScope)
      : undefined;
    const rows = await this.repository.listObservations(watch.query_group_id, limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > limit && last
          ? this.cursor.encode({
              scope: 'OBSERVATIONS',
              parent_id: cursorScope,
              sort_at: last.observed_at,
              id: last.id,
            })
          : null,
    };
  }

  private async requiredWatch(id: string): Promise<PriceWatchRecord> {
    return (await this.repository.find(id)) ?? priceWatchFail('RESOURCE_NOT_FOUND');
  }

  private async writeContext(tripId: string, userId: string, correlationId: string) {
    const context = await this.access.get(tripId, userId, correlationId);
    if (context.state !== 'ACTIVE') return priceWatchFail('STATE_CONFLICT');
    return context;
  }

  private creator(watch: PriceWatchRecord, userId: string, context: PriceTripContext): void {
    if (watch.user_id !== userId || watch.owner_membership_id !== context.membershipId)
      return priceWatchFail('PERMISSION_DENIED');
  }

  private normalized(value: PriceWatchRecord): NormalizedWatchWrite {
    return {
      query: value.query,
      threshold_price: value.threshold_price,
      canonical_key: value.canonical_key,
      request_hash: value.request_hash,
      expires_at: value.expires_at,
    };
  }
}
