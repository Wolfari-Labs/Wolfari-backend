import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { isLoopbackGrpcTarget, type RpcMessage } from './trip-http';

const definition = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS);
const service = definition['wolfari.finance.v1.FinanceService'] as ServiceDefinition;
export class FinanceClient {
  private client?: Client;
  private fileClient?: Client;
  constructor(
    private readonly target: string,
    private readonly secret: string,
  ) {}
  call(
    methodName:
      | 'GetPaymentInstruction'
      | 'ReportContributionTransfer'
      | 'ConfirmContributionReceived'
      | 'RejectContributionTransfer'
      | 'ReverseContribution'
      | 'UpdateContributionRequest'
      | 'UpdateContributionAmount'
      | 'WaiveContribution'
      | 'CancelContribution'
      | 'GetFund'
      | 'ListContributionRequests'
      | 'ListContributions'
      | 'ListPaymentDestinations'
      | 'ListFundTransactions'
      | 'EnableFund'
      | 'ConfirmPaymentDestination'
      | 'UpdateFundBudget'
      | 'CreatePaymentDestination'
      | 'UpdatePaymentDestination'
      | 'CreateContributionRequest',
    request: RpcMessage,
    correlation: string,
  ): Promise<RpcMessage> {
    if (
      !isLoopbackGrpcTarget(this.target) ||
      this.secret.length < 32 ||
      process.env.NODE_ENV === 'production'
    )
      return Promise.reject(new Error('Finance transport unavailable'));
    this.client ??= new Client(this.target, credentials.createInsecure());
    const method = service[methodName] as MethodDefinition<RpcMessage, RpcMessage>;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'ApiGateway');
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlation);
    return new Promise((resolve, reject) =>
      this.client!.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 2000 },
        (error: ServiceError | null, response?: RpcMessage) =>
          error ? reject(error) : resolve(response!),
      ),
    );
  }
  callFile(
    methodName: 'UploadFinanceReceipt' | 'DownloadFinanceReceipt',
    request: RpcMessage,
    correlation: string,
    signal: AbortSignal,
  ): Promise<RpcMessage> {
    if (
      !isLoopbackGrpcTarget(this.target) ||
      this.secret.length < 32 ||
      process.env.NODE_ENV === 'production' ||
      signal.aborted
    )
      return Promise.reject(new Error('Finance transport unavailable'));
    this.fileClient ??= new Client(this.target, credentials.createInsecure(), {
      'grpc.max_receive_message_length': 12 * 1024 * 1024,
      'grpc.max_send_message_length': 12 * 1024 * 1024,
    });
    const method = service[methodName] as MethodDefinition<RpcMessage, RpcMessage>;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'ApiGateway');
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlation);
    return new Promise((resolve, reject) => {
      const abort = () => call.cancel();
      const call = this.fileClient!.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 30000 },
        (error: ServiceError | null, response?: RpcMessage) => {
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve(response!);
        },
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  close() {
    this.client?.close();
    this.fileClient?.close();
  }
}
