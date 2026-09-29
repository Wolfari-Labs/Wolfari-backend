import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { randomUUID } from 'node:crypto';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from './grpc';
import type { IdentityV1 } from './grpc';

const packageDefinition = loadSync(PROTO_PATHS.identity, GRPC_LOADER_OPTIONS);
const identity = packageDefinition['wolfari.identity.v1.IdentityService'] as ServiceDefinition;

export class IdentityClient {
  private readonly client: Client;
  constructor(target: string, private readonly caller: string, private readonly secret: string) {
    this.client = new Client(target, credentials.createInsecure());
  }

  private call<Request extends object, Response extends object>(methodName: string, request: Request, correlationId: string = randomUUID()): Promise<Response> {
    const method = identity[methodName] as unknown as MethodDefinition<Request, Response>;
    const metadata = new Metadata();
    metadata.set('x-caller-service', this.caller);
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlationId);
    return new Promise((resolve, reject) => this.client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      request,
      metadata,
      { deadline: Date.now() + 2000 },
      (error: ServiceError | null, response?: Response) => error ? reject(error) : resolve(response as Response),
    ));
  }

  validateSession(request: IdentityV1.ValidateSessionRequest, correlationId?: string) {
    return this.call<IdentityV1.ValidateSessionRequest, IdentityV1.ValidateSessionResponse>('ValidateSession', request, correlationId);
  }

  getProfiles(request: IdentityV1.GetProfilesRequest, correlationId?: string) {
    return this.call<IdentityV1.GetProfilesRequest, IdentityV1.GetProfilesResponse>('GetProfiles', request, correlationId);
  }

  getAccountEmailDelivery(request: IdentityV1.GetAccountEmailDeliveryRequest, correlationId?: string) {
    return this.call<IdentityV1.GetAccountEmailDeliveryRequest, IdentityV1.GetAccountEmailDeliveryResponse>('GetAccountEmailDelivery', request, correlationId);
  }

  close() { this.client.close(); }
}
