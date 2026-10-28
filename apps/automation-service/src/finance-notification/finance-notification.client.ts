import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import {
  GRPC_LOADER_OPTIONS,
  PROTO_PATHS,
  type FinanceV1,
  type IdentityV1,
} from '@wolfari/contracts/grpc';
import { IdentityClient } from '@wolfari/contracts/identity-client';
import { notificationEnabled, type FinanceNotificationEvent } from './finance-notification.event';

const definition = loadSync(PROTO_PATHS.finance, GRPC_LOADER_OPTIONS)[
  'wolfari.finance.v1.FinanceService'
] as ServiceDefinition;
const method = definition.GetAutomationContext as unknown as MethodDefinition<
  FinanceV1.GetAutomationContextRequest,
  FinanceV1.GetAutomationContextResponse
>;

@Injectable()
export class FinanceNotificationClient implements OnApplicationShutdown {
  private finance?: Client;
  private identity?: IdentityClient;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('AUTOMATION_FINANCE_SECRET') ?? '';
    if (!notificationEnabled(config.get('AUTOMATION_FINANCE_NOTIFICATION_ENABLED'))) return;
    const finance = config.get<string>('FINANCE_GRPC_TARGET') ?? '127.0.0.1:3204';
    const identity = config.get<string>('IDENTITY_GRPC_TARGET') ?? '127.0.0.1:3201';
    const identitySecret = config.get<string>('AUTOMATION_IDENTITY_SECRET') ?? '';
    if (
      ![finance, identity].every(
        (target) =>
          /^127\.0\.0\.1:[0-9]{1,5}$/.test(target) &&
          Number(target.split(':')[1]) > 0 &&
          Number(target.split(':')[1]) <= 65535,
      ) ||
      this.secret.length < 32 ||
      identitySecret.length < 32
    )
      throw new Error('Finance notification RPC configuration invalid');
    if ((config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production')
      throw new Error('Finance notification transport requires TLS in production');
    this.finance = new Client(finance, credentials.createInsecure());
    this.identity = new IdentityClient(identity, 'Automation', identitySecret);
  }

  getContext(
    event: FinanceNotificationEvent,
    deadline: number,
  ): Promise<FinanceV1.GetAutomationContextResponse> {
    const client = this.finance;
    if (!client || Date.now() >= deadline)
      return Promise.reject(new Error('FINANCE_NOTIFICATION_RPC_UNAVAILABLE'));
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'Automation');
    metadata.set('x-service-secret', this.secret);
    metadata.set('x-correlation-id', event.correlationId);
    return new Promise((resolve, reject) =>
      client.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        {
          fund_id: event.fundId,
          ...('closureId' in event
            ? { source_type: 'CLOSURE', source_id: event.closureId }
            : { source_type: 'CONTRIBUTION_REQUEST', source_id: event.requestId }),
        },
        metadata,
        { deadline: Math.min(deadline, Date.now() + 2000) },
        (error: ServiceError | null, response?: FinanceV1.GetAutomationContextResponse) =>
          error ? reject(error) : resolve(response!),
      ),
    );
  }

  getEligibility(
    userIds: string[],
    correlation: string,
    deadline: number,
  ): Promise<IdentityV1.GetNotificationEligibilityResponse> {
    if (!this.identity || Date.now() >= deadline)
      return Promise.reject(new Error('FINANCE_NOTIFICATION_RPC_UNAVAILABLE'));
    return this.identity.getNotificationEligibility({ user_ids: userIds }, correlation, deadline);
  }

  onApplicationShutdown(): void {
    this.finance?.close();
    this.identity?.close();
  }
}
