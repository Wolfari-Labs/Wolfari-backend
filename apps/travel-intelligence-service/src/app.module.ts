import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { PlacesService } from './places.service';
import { PlacesController } from './places.grpc';

@Module({
  imports: [
    InfrastructureModule.forApp('travel-intelligence-service'),
    DatabaseModule.forService('travel'),
  ],
  controllers: [PlacesController],
  providers: [PlacesService],
})
export class AppModule {}
