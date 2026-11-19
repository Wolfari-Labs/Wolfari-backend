import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { assertGatewayCaller } from './gateway-caller';
import { RouteService } from './route.service';

@Controller()
export class RouteController {
  constructor(
    private readonly routes: RouteService,
    private readonly config: ConfigService,
  ) {}
  @GrpcMethod('TravelService', 'GetRoute')
  async getRoute(request: TravelV1.GetRouteRequest, metadata: Metadata) {
    assertGatewayCaller(this.config, metadata);
    try {
      return await this.routes.route(request);
    } catch (error) {
      throw new RpcException({
        code:
          error instanceof Error && error.message === 'VALIDATION_FAILED'
            ? status.INVALID_ARGUMENT
            : status.UNAVAILABLE,
        message: 'Route request failed',
      });
    }
  }
}
