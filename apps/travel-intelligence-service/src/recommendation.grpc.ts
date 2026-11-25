import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { assertCaller } from './gateway-caller';
import { RecommendationService } from './recommendation.service';

/** FR-DS01: only Trip asks for a recommendation; it owns permissions, receipts and apply. */
@Controller()
export class RecommendationController {
  constructor(
    private readonly recommendations: RecommendationService,
    private readonly config: ConfigService,
  ) {}
  @GrpcMethod('TravelService', 'GetRecommendation')
  async getRecommendation(request: TravelV1.GetRecommendationRequest, metadata: Metadata) {
    assertCaller(this.config, metadata, ['Trip']);
    try {
      return await this.recommendations.recommend(request);
    } catch (error) {
      throw new RpcException({
        code:
          error instanceof Error && error.message === 'VALIDATION_FAILED'
            ? status.INVALID_ARGUMENT
            : status.UNAVAILABLE,
        message: 'Recommendation request failed',
      });
    }
  }
}
