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
