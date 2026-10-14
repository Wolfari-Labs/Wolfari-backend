import { PlanService } from './planning/plan.service';
import { MembershipRepository } from './membership/membership.repository';
import { LifecycleFinanceClient } from './operations/lifecycle-finance.client';
import { LifecycleService } from './operations/lifecycle.service';
import { PlanGrpcHandlers } from './planning/plan.grpc';
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { TripAccessService } from './trip-access.service';
import { TripGrpcController } from './trip.grpc';
import { TripPlanAccessService } from './trip-plan-access.service';
import { TripService } from './trip.service';
import { TripInvitationsService } from './trip-invitations.service';
import { TripOutboxService, TripDependenciesController } from './trip-outbox.service';

@Module({
  imports: [
    InfrastructureModule.forApp('trip-workspace-service'),
    DatabaseModule.forService('trip'),
  ],
  controllers: [TripGrpcController, TripDependenciesController],
  providers: [
    MembershipRepository,
    LifecycleFinanceClient,
    LifecycleService,
    TripService,
    PlanService,
    PlanGrpcHandlers,
    TripAccessService,
    TripPlanAccessService,
    TripInvitationsService,
    TripOutboxService,
  ],
})
export class AppModule {}
