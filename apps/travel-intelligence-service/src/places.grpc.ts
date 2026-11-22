import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { assertGatewayCaller } from './gateway-caller';
import { PlacesService } from './places.service';

@Controller()
export class PlacesController {
  constructor(
    private readonly places: PlacesService,
    private readonly config: ConfigService,
  ) {}
  @GrpcMethod('TravelService', 'SearchPlaces')
  async searchPlaces(request: TravelV1.SearchPlacesRequest, metadata: Metadata) {
    assertGatewayCaller(this.config, metadata);
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
