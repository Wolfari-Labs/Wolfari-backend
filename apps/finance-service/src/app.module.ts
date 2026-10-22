import { PaymentInstructionService } from './application/payment-instruction.service';
import { ReceiptService } from './receipts/receipt.service';
import { ManualContributionService } from './application/manual-contribution.service';
import { ReceiptRepository } from './receipts/receipt.repository';
import { ReceiptStorage } from './receipts/receipt-storage';
import { PaymentInstructionRepository } from './repositories/payment-instruction.repository';
import { ContributionReversalService } from './application/contribution-reversal.service';
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
import { ExpenseService } from './application/expense.service';
import { ExpenseRepository } from './repositories/expense.repository';
import { FinancialNoteService } from './application/financial-note.service';
import { FinancialNoteRepository } from './repositories/financial-note.repository';
import { RefundService } from './application/refund.service';
import { RefundRepository } from './repositories/refund.repository';
import { ClosureService } from './application/closure.service';
import { ClosureRepository } from './repositories/closure.repository';

@Module({
  imports: [InfrastructureModule.forApp('finance-service'), DatabaseModule.forService('finance')],
  controllers: [FinanceGrpcController],
  providers: [
    PaymentInstructionService,
    ContributionReversalService,
    PaymentInstructionRepository,
    ManualContributionService,
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
    ExpenseService,
    ExpenseRepository,
    FinancialNoteService,
    FinancialNoteRepository,
    RefundService,
    RefundRepository,
    ClosureService,
    ClosureRepository,
  ],
})
export class AppModule {}
