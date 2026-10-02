import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { AccountEmailDependenciesController, AccountEmailService } from './account-email.service';
import { InvitationDeliveryService, InvitationDependenciesController } from './invitation-delivery.service';

@Module({ imports: [InfrastructureModule.forApp('automation-service'), DatabaseModule.forService('automation')], controllers: [AccountEmailDependenciesController, InvitationDependenciesController], providers: [AccountEmailService, InvitationDeliveryService] })
export class AppModule {}
