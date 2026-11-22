import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { PlacesService } from './places.service';
import { PlacesController } from './places.grpc';
import { RouteService } from './route.service';
import { RouteController } from './route.grpc';
import { PoiImageController } from './poi-image.grpc';

@Module({
  imports: [
    InfrastructureModule.forApp('travel-intelligence-service'),
    DatabaseModule.forService('travel'),
  ],
  controllers: [PlacesController, RouteController, PoiImageController],
  providers: [PlacesService, RouteService],
})
export class AppModule {}
