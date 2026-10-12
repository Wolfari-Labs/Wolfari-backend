import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';

type RpcMessage = Record<string, unknown>;

const packageDefinition = loadSync(PROTO_PATHS.trip, GRPC_LOADER_OPTIONS);
const tripService = packageDefinition['wolfari.trip.v1.TripService'] as ServiceDefinition;

export class TripClient {
  private readonly client: Client;

  constructor(
    target: string,
    private readonly secret: string,
  ) {
    this.client = new Client(target, credentials.createInsecure());
  }

  private call<Request extends RpcMessage, Response extends RpcMessage>(
    methodName: string,
    request: Request,
    correlationId: string,
  ): Promise<Response> {
    const method = tripService[methodName] as unknown as
      MethodDefinition<Request, Response> | undefined;
    if (!method) return Promise.reject(new Error(`Trip RPC ${methodName} is unavailable`));
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'ApiGateway');
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
        (error: ServiceError | null, response?: Response) =>
          error ? reject(error) : resolve(response as Response),
      ),
    );
  }

  createTrip(request: RpcMessage, correlationId: string) {
    return this.call('CreateTrip', request, correlationId);
  }

  listTrips(request: RpcMessage, correlationId: string) {
    return this.call('ListTrips', request, correlationId);
  }

  getTrip(request: RpcMessage, correlationId: string) {
    return this.call('GetTrip', request, correlationId);
  }

  updateTrip(request: RpcMessage, correlationId: string) {
    return this.call('UpdateTrip', request, correlationId);
  }

  updatePlanPolicy(request: RpcMessage, correlationId: string) {
    return this.call('UpdatePlanPolicy', request, correlationId);
  }

  close() {
    this.client.close();
  }
}
