import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { AccountEmailDependenciesController, AccountEmailService } from './account-email.service';
import {
  InvitationDeliveryService,
  InvitationDependenciesController,
} from './invitation-delivery.service';
import { PriceWatchAccessService } from './price-watch/price-watch-access.service';
import { PriceWatchGrpcController } from './price-watch/price-watch.grpc';
import { PriceWatchRepository } from './price-watch/price-watch.repository';
import { PriceWatchService } from './price-watch/price-watch.service';

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
    PriceWatchAccessService,
    PriceWatchRepository,
    PriceWatchService,
  ],
})
export class AppModule {}
