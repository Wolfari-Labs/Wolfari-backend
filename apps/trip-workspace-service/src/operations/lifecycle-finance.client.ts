import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { CommonV1, FinanceV1, GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import type { LifecycleRow } from '../membership/membership.domain';

const service = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
  'wolfari.finance.v1.FinanceService'
] as ServiceDefinition;
@Injectable()
export class LifecycleFinanceClient implements OnApplicationShutdown {
  private readonly client?: Client;
  private readonly secret: string;
  constructor(config: ConfigService) {
    const target = config.get<string>('FINANCE_GRPC_TARGET') ?? '';
    this.secret = config.get<string>('TRIP_FINANCE_SECRET') ?? '';
    if (target || this.secret) {
      if (!/^127\.0\.0\.1:\d+$/.test(target) || this.secret.length < 32)
        throw new Error('Invalid Trip Finance configuration');
      this.client = new Client(target, credentials.createInsecure());
    }
    if (config.get<string>('TRIP_MEMBERSHIP_LIFECYCLE_ENABLED') === 'true' && !this.client)
      throw new Error('Lifecycle requires Finance configuration');
  }
  private call<T>(
    name: string,
    request: object,
    correlation: string,
    deadline: number,
  ): Promise<T> {
    if (!this.client || Date.now() >= deadline)
      return Promise.reject(new Error('Finance unavailable'));
    const method = service[name] as unknown as MethodDefinition<object, T>;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'Trip');
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', correlation);
    return new Promise((resolve, reject) =>
      this.client!.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        request,
        metadata,
        { deadline: Math.min(Date.now() + 2000, deadline) },
        (error, response) => (error ? reject(error) : resolve(response as T)),
      ),
    );
  }
  private request(row: LifecycleRow) {
    const intent = row.command_payload;
    return {
      operation_id: row.operation_id,
      request_hash: row.request_hash,
      authorization_context: intent.authorizationContext,
      membership_target: {
        membership_id: intent.targetMemberId,
        user_id: intent.targetUserId,
        reason: intent.reason,
      },
    };
  }
  async execute(row: LifecycleRow, deadline: number): Promise<CommonV1.Receipt> {
    const result = await this.call<FinanceV1.ExecuteTripOperationResponse>(
      'ExecuteTripOperation',
      { ...this.request(row), operation_type: row.operation_type },
      row.command_payload.correlationId,
      deadline,
    );
    if (!result.receipt) throw new Error('Missing Finance receipt');
    return result.receipt;
  }
  async recover(row: LifecycleRow, deadline: number): Promise<CommonV1.Receipt> {
    const result = await this.call<FinanceV1.GetOperationResultResponse>(
      'GetOperationResult',
      { operation_id: row.operation_id },
      row.command_payload.correlationId,
      deadline,
    );
    if (result.receipt) return result.receipt;
    if (!result.not_found) throw new Error('Invalid Finance result');
    const cancelled = await this.call<FinanceV1.CancelOperationIfNotCommittedResponse>(
      'CancelOperationIfNotCommitted',
      { ...this.request(row), command_scope: row.operation_type },
      row.command_payload.correlationId,
      deadline,
    );
    if (!cancelled.receipt) throw new Error('Missing Finance cancellation receipt');
    return cancelled.receipt;
  }
  onApplicationShutdown() {
    this.client?.close();
  }
}
