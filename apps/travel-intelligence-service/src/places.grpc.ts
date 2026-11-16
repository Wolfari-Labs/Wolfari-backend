import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { PlacesService } from './places.service';

@Controller()
export class PlacesController {
  constructor(
    private readonly places: PlacesService,
    private readonly config: ConfigService,
  ) {}
  @GrpcMethod('TravelService', 'SearchPlaces')
  async searchPlaces(request: TravelV1.SearchPlacesRequest, metadata: Metadata) {
    const expected = Buffer.from(this.config.get<string>('GATEWAY_TRAVEL_SECRET') ?? '');
    const provided = Buffer.from(String(metadata?.get('x-service-secret')[0] ?? ''));
    if (
      metadata?.get('x-caller-service')[0] !== 'ApiGateway' ||
      expected.length < 32 ||
      provided.length !== expected.length ||
      !timingSafeEqual(expected, provided)
    )
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Caller is not authorized',
      });
    try {
      return await this.places.search(request);
    } catch (error) {
      throw new RpcException({
        code:
          error instanceof Error && error.message === 'VALIDATION_FAILED'
            ? status.INVALID_ARGUMENT
            : status.UNAVAILABLE,
        message: 'Places request failed',
      });
    }
  }
}
