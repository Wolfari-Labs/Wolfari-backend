import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { randomUUID } from 'node:crypto';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from './grpc';
import type { TripV1 } from './grpc';

const packageDefinition = loadSync(PROTO_PATHS.trip, GRPC_LOADER_OPTIONS);
const trip = packageDefinition['wolfari.trip.v1.TripService'] as ServiceDefinition;

export type TripAccessCaller = 'Finance' | 'Travel' | 'Automation';

export class TripAccessClient {
  private readonly client: Client;

  constructor(
    target: string,
    private readonly caller: TripAccessCaller,
    private readonly secret: string,
  ) {
    this.client = new Client(target, credentials.createInsecure());
  }

  getAccessContext(
    request: TripV1.GetAccessContextRequest,
    correlationId: string = randomUUID(),
  ): Promise<TripV1.GetAccessContextResponse> {
    const method = trip.GetAccessContext as MethodDefinition<
      TripV1.GetAccessContextRequest,
      TripV1.GetAccessContextResponse
    >;
    const metadata = new Metadata();
    metadata.set('x-caller-service', this.caller);
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlationId);
    return new Promise((resolve, reject) =>
      this.client.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 2000 },
        (error: ServiceError | null, response?: TripV1.GetAccessContextResponse) =>
          error ? reject(error) : resolve(response!),
      ),
    );
  }

  close(): void {
    this.client.close();
  }
}

// Invitation capability is deliberately a separate Automation-only client surface.
export class TripInvitationClient {
  private readonly client: Client;
  constructor(
    target: string,
    private readonly secret: string,
  ) {
    this.client = new Client(target, credentials.createInsecure());
  }
  private call<Request extends object, Response extends object>(
    name: string,
    request: Request,
    correlation: string = randomUUID(),
  ): Promise<Response> {
    const method = trip[name] as unknown as MethodDefinition<Request, Response>;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'Automation');
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlation);
    return new Promise((resolve, reject) =>
      this.client.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 2000 },
        (error: ServiceError | null, response?: Response) =>
          error ? reject(error) : resolve(response!),
      ),
    );
  }
  getInvitationDelivery(request: TripV1.GetInvitationDeliveryRequest, correlation?: string) {
    return this.call<TripV1.GetInvitationDeliveryRequest, TripV1.GetInvitationDeliveryResponse>(
      'GetInvitationDelivery',
      request,
      correlation,
    );
  }
  acknowledgeInvitationDelivery(
    request: TripV1.AcknowledgeInvitationDeliveryRequest,
    correlation?: string,
  ) {
    return this.call<
      TripV1.AcknowledgeInvitationDeliveryRequest,
      TripV1.AcknowledgeInvitationDeliveryResponse
    >('AcknowledgeInvitationDelivery', request, correlation);
  }
  close() {
    this.client.close();
  }
}
