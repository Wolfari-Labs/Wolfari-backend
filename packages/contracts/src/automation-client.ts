import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from './grpc';

type RpcMessage = Record<string, unknown>;

const definition = loadSync(PROTO_PATHS.automation, GRPC_LOADER_OPTIONS);
const automation = definition['wolfari.automation.v1.AutomationService'] as ServiceDefinition;

export class AutomationClient {
  private readonly client: Client;

  constructor(
    target: string,
    private readonly secret: string,
  ) {
    this.client = new Client(target, credentials.createInsecure());
  }

  call<Request extends RpcMessage, Response extends RpcMessage>(
    methodName: string,
    request: Request,
    correlationId: string,
  ): Promise<Response> {
    const method = automation[methodName] as unknown as
      MethodDefinition<Request, Response> | undefined;
    if (!method) return Promise.reject(new Error(`Automation RPC ${methodName} is unavailable`));
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

  close(): void {
    this.client.close();
  }
}
