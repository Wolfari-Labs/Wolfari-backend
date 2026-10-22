import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status, type ServiceError } from '@grpc/grpc-js';
import { CommonV1 } from '@wolfari/contracts/grpc';
import { TripAccessClient } from '@wolfari/contracts/trip-client';
import { priceWatchFail } from './price-watch.errors';
import { watchUuid } from './price-watch.domain';

export interface PriceTripContext {
  membershipId: string;
  role: 'OWNER' | 'MEMBER';
  state: 'ACTIVE' | 'ARCHIVED';
}

@Injectable()
export class PriceWatchAccessService implements OnApplicationShutdown {
  private readonly client: TripAccessClient;

  constructor(config: ConfigService) {
    const target = config.get<string>('TRIP_GRPC_TARGET') ?? '127.0.0.1:3202';
    const secret = config.get<string>('AUTOMATION_TRIP_SECRET') ?? '';
    if (!/^127\.0\.0\.1:\d+$/.test(target) || secret.length < 32)
      throw new Error('Automation Trip configuration invalid');
    if ((config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production')
      throw new Error('Automation Trip transport requires TLS in production');
    this.client = new TripAccessClient(target, 'Automation', secret);
  }

  async get(tripId: string, userId: string, correlationId: string): Promise<PriceTripContext> {
    try {
      const result = await this.client.getAccessContext(
        { trip_id: tripId, user_id: userId, action: 'TRIP_VIEW' },
        correlationId,
      );
      const context = result.context;
      if (!context?.can_read_trip || !context.membership)
        return priceWatchFail('RESOURCE_NOT_FOUND');
      const role = context.membership.role;
      const state = context.trip_state;
      if (
        (role !== CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER &&
          role !== CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER) ||
        (state !== CommonV1.TripState.TRIP_STATE_ACTIVE &&
          state !== CommonV1.TripState.TRIP_STATE_ARCHIVED)
      )
        return priceWatchFail('SERVICE_UNAVAILABLE');
      return {
        membershipId: watchUuid(context.membership.id),
        role: role === CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER ? 'OWNER' : 'MEMBER',
        state: state === CommonV1.TripState.TRIP_STATE_ACTIVE ? 'ACTIVE' : 'ARCHIVED',
      };
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        typeof (error as ServiceError).code === 'number'
      ) {
        if ((error as ServiceError).code === status.NOT_FOUND)
          return priceWatchFail('RESOURCE_NOT_FOUND');
        if ((error as ServiceError).code === status.PERMISSION_DENIED)
          return priceWatchFail('PERMISSION_DENIED');
        return priceWatchFail('SERVICE_UNAVAILABLE');
      }
      throw error;
    }
  }

  onApplicationShutdown(): void {
    this.client.close();
  }
}
