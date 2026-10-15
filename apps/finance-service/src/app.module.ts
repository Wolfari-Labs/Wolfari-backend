import { ReceiptService } from './receipts/receipt.service';
import { ReceiptRepository } from './receipts/receipt.repository';
import { ReceiptStorage } from './receipts/receipt-storage';
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { FundRepository } from './repositories/fund.repository';
import { LedgerRepository } from './repositories/ledger.repository';
import { PaymentDestinationQueryRepository } from './repositories/payment-destination-query.repository';
import { FinanceTripAccess, FundQueryService } from './application/fund-query.service';
import { FinanceGrpcController } from './finance.grpc';
import { FundCommandRepository } from './repositories/fund-command.repository';
import { FundCommandService, FundTripClient } from './application/fund-command.service';
import { ContributionRepository } from './repositories/contribution.repository';
import { PaymentDestinationRepository } from './repositories/payment-destination.repository';
import { ContributionCommandService } from './application/contribution-command.service';
import { ContributionQueryService } from './application/contribution-query.service';
import { ContributionListRepository } from './repositories/contribution-list.repository';

@Module({
  imports: [InfrastructureModule.forApp('finance-service'), DatabaseModule.forService('finance')],
  controllers: [FinanceGrpcController],
  providers: [
    ReceiptService,
    ReceiptRepository,
    ReceiptStorage,
    FundRepository,
    LedgerRepository,
    PaymentDestinationQueryRepository,
    FinanceTripAccess,
    FundQueryService,
    FundCommandRepository,
    FundCommandService,
    FundTripClient,
    ContributionRepository,
    PaymentDestinationRepository,
    ContributionCommandService,
    ContributionQueryService,
    ContributionListRepository,
  ],
})
export class AppModule {}
