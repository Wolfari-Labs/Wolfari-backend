import { TravelGrpcController } from './travel.grpc';
import { PlacesService } from './places.service';
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';

@Module({
  imports: [
    InfrastructureModule.forApp('travel-intelligence-service'),
    DatabaseModule.forService('travel'),
  ],
  controllers: [TravelGrpcController],
  providers: [PlacesService],
})
export class AppModule {}
