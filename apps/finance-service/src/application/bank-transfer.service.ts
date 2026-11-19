import { Inject, Injectable } from '@nestjs/common';
import { CommonV1, type FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import { parseBankTransferInput, parseBankTransferResolution } from '../inputs/bank-transfer.input';
import { bankTransferResponse } from '../projections/bank-transfer-response';
import { BankTransferRepository } from '../repositories/bank-transfer.repository';
import { FundQueryService } from './fund-query.service';

@Injectable()
export class BankTransferService {
  constructor(
    @Inject(FundQueryService)
    private readonly queries: Pick<FundQueryService, 'authorizeFundRead' | 'authorizeActiveFundWrite'>,
    @Inject(BankTransferRepository)
    private readonly rows: Pick<BankTransferRepository, 'receive' | 'list' | 'fundHolder' | 'resolve'>,
  ) {}

  /** Gateway-authenticated provider webhook; the Gateway already verified the provider signature. */
  async receive(
    request: FinanceV1.ReceiveBankTransferRequest,
    correlation: string,
  ): Promise<FinanceV1.ReceiveBankTransferResponse> {
    const result = await this.rows.receive(parseBankTransferInput(request), correlation);
    return {
      receipt_id: result.receiptId,
      processing_status: result.status,
      contribution_id: result.contributionId ?? undefined,
    };
  }

  /** Owner or current Holder only: incoming money is private bank data of the Holder's account. */
  async list(
    request: FinanceV1.ListBankTransfersRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListBankTransfersResponse> {
    const fundId = readUuid(request.fund_id),
      actor = readUuid(request.actor_user_id);
    const holder = await this.rows.fundHolder(fundId);
    if (!holder) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const role = await this.queries.authorizeFundRead(fundId, actor, correlation, deadline);
    if (role !== CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER && actor !== holder)
      throw new FinanceReadError('PERMISSION_DENIED');
    return { items: (await this.rows.list(fundId)).map(bankTransferResponse) };
  }

  /** Current Holder of an active Trip records how a transfer needing review was handled. */
  async resolve(
    request: FinanceV1.ResolveBankTransferRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ResolveBankTransferResponse> {
    const input = parseBankTransferResolution(request);
    await this.queries.authorizeActiveFundWrite(input.fundId, input.actor, correlation, deadline);
    const result = await this.rows.resolve(input, correlation);
    return {
      bank_transfer: bankTransferResponse(result.row),
      finance_version: result.financeVersion,
    };
  }
}
