import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { PlacesService } from './places.service';

@Controller()
export class TravelGrpcController {
  constructor(private readonly places: PlacesService) {}
  @GrpcMethod('TravelService', 'SearchPlaces')
  searchPlaces(request: TravelV1.SearchPlacesRequest, metadata?: Metadata) {
    return this.places.search(request, metadata);
  }
}
