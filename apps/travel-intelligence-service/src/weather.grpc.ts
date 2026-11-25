import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { TravelV1 } from '@wolfari/contracts/grpc';
import { assertGatewayCaller } from './gateway-caller';
import { WeatherService } from './weather.service';

@Controller()
export class WeatherController {
  constructor(
    private readonly weather: WeatherService,
    private readonly config: ConfigService,
  ) {}
  @GrpcMethod('TravelService', 'GetWeather')
  async getWeather(request: TravelV1.GetWeatherRequest, metadata: Metadata) {
    assertGatewayCaller(this.config, metadata);
    try {
      return await this.weather.weather(request);
    } catch (error) {
      throw new RpcException({
        code:
          error instanceof Error && error.message === 'VALIDATION_FAILED'
            ? status.INVALID_ARGUMENT
            : status.UNAVAILABLE,
        message: 'Weather request failed',
      });
    }
  }
}
