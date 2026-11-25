import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { PlacesService } from './places.service';
import { PlacesController } from './places.grpc';
import { RouteService } from './route.service';
import { RouteController } from './route.grpc';
import { WeatherService } from './weather.service';
import { WeatherController } from './weather.grpc';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.grpc';

@Module({
  imports: [
    InfrastructureModule.forApp('travel-intelligence-service'),
    DatabaseModule.forService('travel'),
  ],
  controllers: [PlacesController, RouteController, WeatherController, RecommendationController],
  providers: [PlacesService, RouteService, WeatherService, RecommendationService],
})
export class AppModule {}
