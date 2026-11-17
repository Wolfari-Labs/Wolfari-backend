import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { loadSync, type ServiceDefinition, type MethodDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS, type TripV1 } from '@wolfari/contracts/grpc';
import { IdentityClient } from '@wolfari/contracts/identity-client';
import { randomUUID } from 'node:crypto';
import { PriceWatchAccessService } from '../price-watch/price-watch-access.service';

const definition = loadSync(PROTO_PATHS.trip, GRPC_LOADER_OPTIONS)[
  'wolfari.trip.v1.TripService'
] as ServiceDefinition;
@Injectable()
export class DeliveryContextClient {
  private readonly trip: Client;
  private readonly identity: IdentityClient;
  private readonly secret: string;
  constructor(
    config: ConfigService,
    private readonly access: PriceWatchAccessService,
  ) {
    const target = config.get<string>('TRIP_GRPC_TARGET') ?? '127.0.0.1:3202';
    this.secret = config.get<string>('AUTOMATION_TRIP_SECRET') ?? '';
    const identityTarget = config.get<string>('IDENTITY_GRPC_TARGET') ?? '127.0.0.1:3201',
      identitySecret = config.get<string>('AUTOMATION_IDENTITY_SECRET') ?? '';
    if (
      ![target, identityTarget].every((t) => /^127\.0\.0\.1:\d+$/.test(t)) ||
      this.secret.length < 32 ||
      identitySecret.length < 32
    )
      throw Error('Notification context configuration invalid');
    this.trip = new Client(target, credentials.createInsecure());
    this.identity = new IdentityClient(identityTarget, 'Automation', identitySecret);
  }
  async source(request: TripV1.GetAutomationContextRequest, correlation: string = randomUUID()) {
    const method = definition.GetAutomationContext as MethodDefinition<
      TripV1.GetAutomationContextRequest,
      TripV1.GetAutomationContextResponse
    >;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'Automation');
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlation);
    const result = await new Promise<TripV1.GetAutomationContextResponse>((resolve, reject) =>
      this.trip.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 2000 },
        (error, value?: TripV1.GetAutomationContextResponse) =>
          error ? reject(error) : resolve(value!),
      ),
    );
    const context = result.context;
    if (
      !context ||
      context.source_id !== request.source_id ||
      context.source_type !== request.source_type ||
      !context.source_revision
    )
      throw Error('Reminder source unavailable');
    const at = context.remind_at
      ? new Date(
          Number(context.remind_at.seconds) * 1000 +
            Math.floor((context.remind_at.nanos ?? 0) / 1000000),
        ).toISOString()
      : null;
    return { allowed: context.allowed === true, at, revision: context.source_revision };
  }
  async eligible(userId: string, tripId: string | null, correlation: string = randomUUID(), sessionFamilyId?: string) {
    const response = await this.identity.getNotificationEligibility(
      { user_ids: [userId], ...(sessionFamilyId ? { session_family_id: sessionFamilyId } : {}) },
      correlation,
      Date.now() + 2000,
    );
    if (response.recipients?.length !== 1 || response.recipients[0]?.user_id !== userId)
      throw Error('Notification eligibility unavailable');
    if (response.recipients[0].eligible !== true) return false;
    if (tripId) {
      const context = await this.access.get(tripId, userId, correlation);
      return context.state === 'ACTIVE';
    }
    return true;
  }
  onApplicationShutdown() {
    this.trip.close();
    this.identity.close();
  }
}
