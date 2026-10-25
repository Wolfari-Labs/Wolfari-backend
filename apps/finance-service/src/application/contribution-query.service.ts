import { Inject, Injectable } from '@nestjs/common';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FundQueryService } from './fund-query.service';
import { ContributionListRepository } from '../repositories/contribution-list.repository';
import { parseContributionPage } from '../inputs/contribution-page.input';
import { readUuid } from '../finance.errors';
import {
  contributionResponse,
  contributionRequestReadResponse,
  type ContributionReadRow,
  type ContributionRequestReadRow,
} from '../projections/contribution-response';

@Injectable()
export class ContributionQueryService {
  constructor(
    @Inject(FundQueryService) private readonly auth: Pick<FundQueryService, 'authorizeFundRead'>,
    @Inject(ContributionListRepository)
    private readonly rows: Pick<ContributionListRepository, 'list'>,
  ) {}
  private async read(
    kind: 'requests' | 'contributions',
    input: FinanceV1.ListContributionsRequest,
    correlation: string,
    deadline: number,
  ) {
    const actor = readUuid(input.actor_user_id);
    const page = parseContributionPage(kind, input);
    await this.auth.authorizeFundRead(page.fundId, actor, correlation, deadline);
    // Only start the database snapshot after the authority RPC has completed.
    return this.rows.list(page);
  }
  async listRequests(
    input: FinanceV1.ListContributionRequestsRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListContributionRequestsResponse> {
    const result = await this.read('requests', input, correlation, deadline);
    return {
      items: result.items.map((row) =>
        contributionRequestReadResponse(row as ContributionRequestReadRow, result.financeVersion),
      ),
      next_cursor: result.nextCursor,
    };
  }
  async listContributions(
    input: FinanceV1.ListContributionsRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListContributionsResponse> {
    const result = await this.read('contributions', input, correlation, deadline);
    return {
      items: result.items.map((row) =>
        contributionResponse(row as ContributionReadRow, result.financeVersion),
      ),
      next_cursor: result.nextCursor,
    };
  }
}
