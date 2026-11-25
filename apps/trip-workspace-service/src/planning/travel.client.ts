import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS, TravelV1 } from '@wolfari/contracts/grpc';

const service = loadSync(PROTO_PATHS.travel, GRPC_LOADER_OPTIONS)[
  'wolfari.travel.v1.TravelService'
] as ServiceDefinition;

/**
 * Trip → Travel for FR-DS01. Optional: without TRAVEL_GRPC_TARGET and TRIP_TRAVEL_SECRET the
 * rest of Trip runs and a recommendation request answers SERVICE_UNAVAILABLE.
 */
@Injectable()
export class TravelClient implements OnApplicationShutdown {
  private readonly client?: Client;
  private readonly secret: string;
  constructor(config: ConfigService) {
    const target = config.get<string>('TRAVEL_GRPC_TARGET') ?? '';
    this.secret = config.get<string>('TRIP_TRAVEL_SECRET') ?? '';
    if (target || this.secret) {
      if (!/^127\.0\.0\.1:\d+$/.test(target) || this.secret.length < 32)
        throw new Error('Invalid Trip Travel configuration');
      this.client = new Client(target, credentials.createInsecure());
    }
  }
  get configured() {
    return !!this.client;
  }
  recommend(
    request: TravelV1.GetRecommendationRequest,
    correlation: string,
  ): Promise<TravelV1.GetRecommendationResponse> {
    if (!this.client) return Promise.reject(new Error('Travel unavailable'));
    const method = service.GetRecommendation as unknown as MethodDefinition<
      TravelV1.GetRecommendationRequest,
      TravelV1.GetRecommendationResponse
    >;
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
        { deadline: Date.now() + 8000 },
        (error, response) =>
          error ? reject(error) : resolve(response as TravelV1.GetRecommendationResponse),
      ),
    );
  }
  onApplicationShutdown() {
    this.client?.close();
  }
}
