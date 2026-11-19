import { TripManagementService } from './trip-management.service';
import { PlanPdfService } from './plan-pdf.service';
import { PlanItemsService } from './planning/plan-items.service';
import { PlanService } from './planning/plan.service';
import { MembershipRepository } from './membership/membership.repository';
import { MemberProfilesService } from './membership/member-profiles.service';
import { LifecycleFinanceClient } from './operations/lifecycle-finance.client';
import { LifecycleService } from './operations/lifecycle.service';
import { FinanceOperationService } from './operations/finance-operation.service';
import { PlanGrpcHandlers } from './planning/plan.grpc';
import { DressCodeService } from './planning/dress-code.service';
import { Module } from '@nestjs/common';
import { DressCodeImageService } from './planning/dress-code-image.service';
import { TripCoverService } from './trip-cover.service';
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
    TripManagementService,
    PlanPdfService,
    MembershipRepository,
    MemberProfilesService,
    LifecycleFinanceClient,
    LifecycleService,
    FinanceOperationService,
    TripService,
    PlanService,
    PlanItemsService,
    DressCodeService,
    DressCodeImageService,
    TripCoverService,
    PlanGrpcHandlers,
    TripAccessService,
    TripPlanAccessService,
    TripInvitationsService,
    TripOutboxService,
  ],
})
export class AppModule {}
