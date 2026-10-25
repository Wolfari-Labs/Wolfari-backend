import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { NotificationRepository } from './notification/notification.repository';
import { NotificationService } from './notification/notification.service';
import { AccountEmailDependenciesController, AccountEmailService } from './account-email.service';
import {
  InvitationDeliveryService,
  InvitationDependenciesController,
} from './invitation-delivery.service';
import { PriceWatchAccessService } from './price-watch/price-watch-access.service';
import { PriceWatchGrpcController } from './price-watch/price-watch.grpc';
import { MockFlightPriceProvider } from './price-watch/price-watch-provider';
import { PriceAlertRepository } from './price-watch/price-alert.repository';
import { PriceAlertService } from './price-watch/price-alert.service';
import { PriceWatchRepository } from './price-watch/price-watch.repository';
import { PriceWatchService } from './price-watch/price-watch.service';
import { PriceWatchWorkerRepository } from './price-watch/price-watch-worker.repository';
import { PriceWatchWorkerService } from './price-watch/price-watch-worker.service';
import { PriceWatchLifecycleConsumer } from './price-watch/price-watch-lifecycle.consumer';
import { PriceWatchLifecycleRepository } from './price-watch/price-watch-lifecycle.repository';

@Module({
  imports: [
    InfrastructureModule.forApp('automation-service'),
    DatabaseModule.forService('automation'),
  ],
  controllers: [
    AccountEmailDependenciesController,
    InvitationDependenciesController,
    PriceWatchGrpcController,
  ],
  providers: [
    AccountEmailService,
    InvitationDeliveryService,
    NotificationRepository,
    NotificationService,
    PriceWatchAccessService,
    PriceAlertRepository,
    PriceAlertService,
    PriceWatchLifecycleRepository,
    PriceWatchLifecycleConsumer,
    MockFlightPriceProvider,
    PriceWatchRepository,
    PriceWatchService,
    PriceWatchWorkerRepository,
    PriceWatchWorkerService,
  ],
})
export class AppModule {}
