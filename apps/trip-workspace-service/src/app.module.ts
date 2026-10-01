import { PlanService } from './planning/plan.service';
import { PlanGrpcHandlers } from './planning/plan.grpc';
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { TripAccessService } from './trip-access.service';
import { TripGrpcController } from './trip.grpc';
import { TripPlanAccessService } from './trip-plan-access.service';
import { TripService } from './trip.service';

@Module({
  imports: [
    InfrastructureModule.forApp('trip-workspace-service'),
    DatabaseModule.forService('trip'),
  ],
  controllers: [TripGrpcController],
  providers: [TripService, PlanService, PlanGrpcHandlers, TripAccessService, TripPlanAccessService],
})
export class AppModule {}
