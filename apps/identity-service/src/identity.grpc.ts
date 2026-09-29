import { Controller } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { IdentityV1, RPC_CATALOG } from '@wolfari/contracts/grpc';
import { IdentityError, IdentityService } from './identity.service';

const credentials: Record<string, string> = {
  ApiGateway: 'GATEWAY_IDENTITY_SECRET',
  Automation: 'AUTOMATION_IDENTITY_SECRET',
  Trip: 'TRIP_IDENTITY_SECRET',
  Finance: 'FINANCE_IDENTITY_SECRET',
  Travel: 'TRAVEL_IDENTITY_SECRET',
  ExportWorker: 'EXPORT_IDENTITY_SECRET',
};

@Controller()
@IdentityV1.IdentityServiceControllerMethods()
export class IdentityGrpcController implements IdentityV1.IdentityServiceController {
  constructor(private readonly identity: IdentityService, private readonly config: ConfigService) {}

  private authorize(method: string, metadata?: Metadata) {
    const caller = String(metadata?.get('x-caller-service')[0] ?? '');
    const secret = String(metadata?.get('x-service-secret')[0] ?? '');
    const correlation = String(metadata?.get('x-correlation-id')[0] ?? '');
    const entry = RPC_CATALOG.find(value => value.package === 'wolfari.identity.v1' && value.method === method);
    const expected = this.config.get<string>(credentials[caller] ?? '');
    const provided = Buffer.from(secret);
    const known = Buffer.from(expected ?? '');
    const validSecret = known.length > 0 && provided.length === known.length && timingSafeEqual(provided, known);
    if (!entry?.callers.includes(caller) || !validSecret || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(correlation)) {
      throw new RpcException({ code: status.PERMISSION_DENIED, message: 'Caller is not authorized' });
    }
  }

  private async execute<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof IdentityError) throw new RpcException({ code: error.status === 401 ? status.UNAUTHENTICATED : status.INVALID_ARGUMENT, message: error.code });
      throw new RpcException({ code: status.UNAVAILABLE, message: 'Identity temporarily unavailable' });
    }
  }

  validateSession(request: IdentityV1.ValidateSessionRequest, metadata?: Metadata): Promise<IdentityV1.ValidateSessionResponse> {
    this.authorize('ValidateSession', metadata);
    return this.execute(async () => {
      const { user, expiresAt } = await this.identity.validateAccess(request.access_token);
      return { user_id: user.id, system_role: user.system_role === 'ADMIN' ? 2 : 1, status: 1, expires_at: { seconds: String(Math.floor(expiresAt.getTime() / 1000)), nanos: 0 } };
    });
  }

  getProfiles(request: IdentityV1.GetProfilesRequest, metadata?: Metadata): Promise<IdentityV1.GetProfilesResponse> {
    this.authorize('GetProfiles', metadata);
    return this.execute(() => this.identity.profiles(request.user_ids));
  }

  getAccountEmailDelivery(request: IdentityV1.GetAccountEmailDeliveryRequest, metadata?: Metadata): Promise<IdentityV1.GetAccountEmailDeliveryResponse> {
    this.authorize('GetAccountEmailDelivery', metadata);
    return this.execute(() => this.identity.emailDelivery(request.token_id));
  }
}
