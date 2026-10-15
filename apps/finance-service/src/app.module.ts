import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { FundRepository } from './repositories/fund.repository';
import { LedgerRepository } from './repositories/ledger.repository';
import { ContributionRepository } from './repositories/contribution.repository';
import { PaymentDestinationRepository } from './repositories/payment-destination.repository';

@Module({
  imports: [InfrastructureModule.forApp('finance-service'), DatabaseModule.forService('finance')],
  providers: [
    FundRepository,
    LedgerRepository,
    ContributionRepository,
    PaymentDestinationRepository,
  ],
})
export class AppModule {}
