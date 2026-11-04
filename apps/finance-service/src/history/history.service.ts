import { Inject, Injectable } from '@nestjs/common';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FundQueryService } from '../application/fund-query.service';
import { FinanceReadError } from '../finance.errors';
import { historyCursor, historyPage, historyResponse } from './history.domain';
import { FinanceHistoryRepository } from './history.repository';

@Injectable()
export class FinanceHistoryService {
  constructor(
    @Inject(FundQueryService) private readonly auth: Pick<FundQueryService, 'authorizeFundRead'>,
    @Inject(FinanceHistoryRepository)
    private readonly repository: Pick<FinanceHistoryRepository, 'list'>,
  ) {}
  async list(
    input: FinanceV1.ListFundHistoryRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListFundHistoryResponse> {
    const page = historyPage(input);
    await this.auth.authorizeFundRead(page.fundId, page.actorId, correlation, deadline);
    const rows = await this.repository.list(page, deadline);
    const items = rows.slice(0, page.limit).map((row) => historyResponse(row, page.fundId));
    const last = rows[Math.min(rows.length, page.limit) - 1];
    const response = {
      items,
      next_cursor:
        rows.length > page.limit && last
          ? historyCursor(page, { at: last.occurred_at, id: last.id })
          : undefined,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024)
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    // These are current-access observations, not a distributed membership lock.
    await this.auth.authorizeFundRead(page.fundId, page.actorId, correlation, deadline);
    if (Date.now() >= deadline) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    return response;
  }
}
